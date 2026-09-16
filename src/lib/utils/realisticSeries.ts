import { redistributeProportionally } from "@/lib/services/WorkbookSyncEngine";

export const DEFAULT_REALISTIC_VARIATION = 0.15;

/**
 * `count` non-negative values that vary randomly (±`variation`, default
 * ±15%) around an equal share of `total`, summing EXACTLY to `total` at the
 * given precision — the general uniform-weight counterpart to the
 * noisy-weights-then-`redistributeProportionally` pattern used in
 * `MonthlySplitUpEngine.ts` (whose weights are shaped by real monthly
 * totals, not a flat equal share). Deterministic given `rng`.
 */
export function generateRealisticExactSplit(
  total: number,
  count: number,
  rng: () => number,
  options?: { precision?: number; variation?: number },
): number[] {
  if (count === 0) return [];
  const precision = options?.precision ?? 100;
  const variation = options?.variation ?? DEFAULT_REALISTIC_VARIATION;

  if (total <= 0) return new Array(count).fill(0);

  const equalShare = total / count;
  const weights = Array.from({ length: count }, () =>
    Math.max(0.01, equalShare * (1 + (rng() * 2 - 1) * variation)),
  );
  return redistributeProportionally(weights, total, precision);
}
