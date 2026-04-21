/** Minimum normalized confidence before MCP forget deletes the top search hit (semantic search is approximate). */
export const MIN_DELETE_CONFIDENCE = 0.75;
/** Maps fused RRF scores (~0.02–0.12 typical) into [0,1]; tune with {@link MIN_DELETE_CONFIDENCE}. */
const FUSED_SCORE_REFERENCE_MAX = 0.08;
/** Cap recall breadth from MCP (REST contract unchanged). */
export const RECALL_TOP_K = 5;
export const CONTEXT_BUDGET_CHARS = 2500;
export const CONTEXT_SECTION_PROFILE_RATIO = 0.3;
export const CONTEXT_SECTION_HISTORY_RATIO = 0.55;

export function normalizedConfidenceFromFusionScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score / FUSED_SCORE_REFERENCE_MAX));
}

export function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function extractQueryKeywords(q: string, max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of q.toLowerCase().split(/[^a-z0-9]+/)) {
    const w = raw.trim();
    if (w.length < 2) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export function buildRecallReasoning(query: string, rows: Array<{ text?: string }>): string[] {
  const lines: string[] = [];
  const keywords = extractQueryKeywords(query);
  if (keywords.length > 0 && rows.length > 0) {
    const blob = rows.map((r) => (typeof r.text === "string" ? r.text : "")).join(" ").toLowerCase();
    const hits = keywords.filter((k) => blob.includes(k));
    if (hits.length > 0) {
      lines.push(`Matches query keywords: ${hits.slice(0, 8).join(", ")}`);
    }
  }
  const sample = `${query} ${rows.map((r) => r.text).join(" ")}`.toLowerCase();
  if (/\bmcp\b|memorynode|hosted mcp/.test(sample)) {
    lines.push("Recent interaction related to MCP");
  }
  if (sample.includes("preference") || sample.includes("prefer ")) {
    lines.push("User preference match (lexical cue in retrieved text)");
  }
  if (lines.length === 0 && rows.length > 0) {
    lines.push("Ranked by hybrid semantic + lexical relevance for this workspace scope");
  }
  return lines;
}

export function formatSearchResults(data: unknown): string {
  const results = Array.isArray((data as { results?: unknown })?.results)
    ? (data as {
        results: Array<{ text?: string; score?: number; memory_id?: string; id?: string }>;
      }).results
    : [];
  if (results.length === 0) return "No memories found.";
  return results
    .map((r, i) => {
      const score = typeof r.score === "number" ? r.score.toFixed(2) : "—";
      const id =
        typeof r.memory_id === "string"
          ? r.memory_id
          : typeof r.id === "string"
            ? r.id
            : "";
      const text = typeof r.text === "string" ? r.text : "";
      return `### ${i + 1}${id ? ` (memory_id: ${id})` : ""}\n**Score:** ${score}\n\n${text}\n`;
    })
    .join("\n");
}

export function readRows(data: unknown): Array<{ memory_id?: string; id?: string; text?: string; score?: number; created_at?: string }> {
  return Array.isArray((data as { results?: unknown })?.results)
    ? (data as {
        results: Array<{ memory_id?: string; id?: string; text?: string; score?: number; created_at?: string }>;
      }).results
    : [];
}

function recencyScore(createdAt?: string): number {
  if (!createdAt) return 0.5;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0.5;
  const ageHours = Math.max(0, (Date.now() - t) / 3_600_000);
  return 1 / (1 + ageHours / 24);
}

export function buildContextPayload(args: {
  query: string;
  searchRows: Array<{ memory_id?: string; text?: string; score?: number; created_at?: string }>;
  recentRows: Array<{ text?: string; created_at?: string }>;
}): {
  profileFacts: string[];
  relevantHistory: Array<{ memory_id: string; text: string; score: number }>;
  guidance: string[];
} {
  const seen = new Set<string>();
  const relevant = args.searchRows
    .map((r) => ({
      memory_id: typeof r.memory_id === "string" ? r.memory_id : "",
      text: typeof r.text === "string" ? r.text : "",
      score: typeof r.score === "number" ? r.score : 0,
      created_at: r.created_at,
    }))
    .filter((r) => r.text.length > 0)
    .map((r) => {
      const blended = r.score * 0.8 + recencyScore(r.created_at) * 0.2;
      return { ...r, blended };
    })
    .sort((a, b) => b.blended - a.blended)
    .filter((r) => {
      const k = normalizeForDedupe(r.text);
      if (k.length === 0 || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => ({ memory_id: r.memory_id, text: r.text, score: r.score }));

  const profileFacts = args.recentRows
    .map((r) => (typeof r.text === "string" ? r.text : ""))
    .filter((t) => t.length > 0)
    .map((t) => t.trim())
    .slice(0, 8);

  const guidance = [
    "Use recalled facts directly when confidence is high.",
    "If confidence is low, ask a clarifying question before assuming.",
    `Query intent: ${args.query.trim().slice(0, 200)}`,
  ];

  return { profileFacts, relevantHistory: relevant, guidance };
}

export function truncateContextSections(context: {
  profileFacts: string[];
  relevantHistory: Array<{ memory_id: string; text: string; score: number }>;
  guidance: string[];
}): {
  profileFacts: string[];
  relevantHistory: Array<{ memory_id: string; text: string; score: number }>;
  guidance: string[];
  usedChars: number;
  truncated: boolean;
  steps: string[];
} {
  const profileBudget = Math.floor(CONTEXT_BUDGET_CHARS * CONTEXT_SECTION_PROFILE_RATIO);
  const historyBudget = Math.floor(CONTEXT_BUDGET_CHARS * CONTEXT_SECTION_HISTORY_RATIO);
  const guidanceBudget = Math.max(120, CONTEXT_BUDGET_CHARS - profileBudget - historyBudget);
  const steps: string[] = [];

  const trimList = (items: string[], budget: number, step: string): string[] => {
    const out: string[] = [];
    let used = 0;
    for (const item of items) {
      if (used + item.length > budget) {
        steps.push(step);
        break;
      }
      out.push(item);
      used += item.length;
    }
    return out;
  };

  const profileFacts = trimList(context.profileFacts, profileBudget, "profile_trimmed");
  const guidance = trimList(context.guidance, guidanceBudget, "guidance_trimmed");
  const relevantHistory: Array<{ memory_id: string; text: string; score: number }> = [];
  let historyUsed = 0;
  for (const row of context.relevantHistory) {
    if (historyUsed + row.text.length > historyBudget) {
      steps.push("history_tail_dropped");
      break;
    }
    relevantHistory.push(row);
    historyUsed += row.text.length;
  }

  const usedChars =
    profileFacts.reduce((n, x) => n + x.length, 0) +
    guidance.reduce((n, x) => n + x.length, 0) +
    relevantHistory.reduce((n, x) => n + x.text.length, 0);
  return {
    profileFacts,
    relevantHistory,
    guidance,
    usedChars,
    truncated: steps.length > 0,
    steps,
  };
}

export type ProfileEngineView = {
  identity: { workspace_id: string; container_tag: string };
  preferences: string[];
  projects: string[];
  goals: string[];
  constraints: string[];
  last_updated: string;
  confidence: number;
};

export function buildProfileEngine(args: {
  workspaceId: string;
  containerTag: string;
  recentTexts: string[];
  historyTexts: string[];
}): ProfileEngineView {
  const all = [...args.recentTexts, ...args.historyTexts].map((x) => x.trim()).filter((x) => x.length > 0);
  const pick = (matcher: RegExp, limit: number): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const ordered = [...all].reverse();
    for (const row of ordered) {
      if (!matcher.test(row.toLowerCase())) continue;
      const key = normalizeForDedupe(row);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  };
  const preferences = pick(/\bprefer|likes|favorite|usually\b/, 8);
  const projects = pick(/\bproject|building|working on|repo\b/, 8);
  const goals = pick(/\bgoal|deadline|milestone|plan\b/, 8);
  const constraints = pick(/\bnever|do not|can't|cannot|allergic|avoid\b/, 8);
  const correctionCount = all.filter((row) => /\bactually|correction|update\b/i.test(row)).length;
  const filledBuckets = [preferences, projects, goals, constraints].filter((bucket) => bucket.length > 0).length;
  const confidence = Math.min(1, Math.max(0.1, (filledBuckets + Math.min(1, correctionCount)) / 4));
  return {
    identity: { workspace_id: args.workspaceId, container_tag: args.containerTag },
    preferences,
    projects,
    goals,
    constraints,
    last_updated: new Date().toISOString(),
    confidence,
  };
}
