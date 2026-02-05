export const FREE_DAILY_WRITES = 200;
export const FREE_DAILY_READS = 500;
export const FREE_DAILY_EMBEDS = 2000;

export const PRO_DAILY_WRITES = 2000;
export const PRO_DAILY_READS = 5000;
export const PRO_DAILY_EMBEDS = 20000;

export const TEAM_DAILY_WRITES = 10000;
export const TEAM_DAILY_READS = 20000;
export const TEAM_DAILY_EMBEDS = 100000;

export const MAX_TEXT_CHARS = 50_000;
export const MAX_QUERY_CHARS = 2_000;
export const DEFAULT_TOPK = 8;
export const MAX_TOPK = 20;

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 60;

export type UsageCaps = { writes: number; reads: number; embeds: number };

export const capsByPlan: Record<"free" | "pro" | "team", UsageCaps> = {
  free: {
    writes: FREE_DAILY_WRITES,
    reads: FREE_DAILY_READS,
    embeds: FREE_DAILY_EMBEDS,
  },
  pro: {
    writes: PRO_DAILY_WRITES,
    reads: PRO_DAILY_READS,
    embeds: PRO_DAILY_EMBEDS,
  },
  team: {
    writes: TEAM_DAILY_WRITES,
    reads: TEAM_DAILY_READS,
    embeds: TEAM_DAILY_EMBEDS,
  },
};

export type UsageSnapshot = { writes: number; reads: number; embeds: number };
export type UsageDelta = { writesDelta: number; readsDelta: number; embedsDelta: number };

export function exceedsCaps(caps: UsageCaps, usage: UsageSnapshot, delta: UsageDelta): boolean {
  const wouldWrites = usage.writes + delta.writesDelta;
  const wouldReads = usage.reads + delta.readsDelta;
  const wouldEmbeds = usage.embeds + delta.embedsDelta;
  return wouldWrites > caps.writes || wouldReads > caps.reads || wouldEmbeds > caps.embeds;
}
