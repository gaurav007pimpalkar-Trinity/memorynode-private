/**
 * Pure helpers for founder Phase 1 comparison bars (current vs previous window).
 * Values are scaled so the larger of the two maps to 100% bar width.
 */
export function relativeBarPercents(current: number, previous: number): { currentPct: number; previousPct: number } {
  const safeCurr = Number.isFinite(current) ? current : 0;
  const safePrev = Number.isFinite(previous) ? previous : 0;
  const denom = Math.max(safeCurr, safePrev, 1e-9);
  return {
    currentPct: (safeCurr / denom) * 100,
    previousPct: (safePrev / denom) * 100,
  };
}
