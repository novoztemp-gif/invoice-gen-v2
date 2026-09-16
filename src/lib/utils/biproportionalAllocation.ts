import { redistributeProportionally } from "@/lib/services/WorkbookSyncEngine";

export interface BiproportionalInput {
  /** [row][col] initial non-negative weights, e.g. a quantity matrix. */
  seed: number[][];
  /** Target row sums (e.g. each product's annual taxable value). */
  rowTotals: number[];
  /** Target column sums (e.g. each month's total sales). */
  colTotals: number[];
  /** Alternating row/column rescale passes before discretizing. */
  maxIterations?: number;
  /** Discretization units per whole 1 — 100 (default) for 2-decimal
   * currency, 1 for whole numbers, 4 for quarter-increments. Passed
   * straight through to `redistributeProportionally`. */
  precision?: number;
}

export interface BiproportionalResult {
  /** Rows sum EXACTLY to rowTotals AND columns sum EXACTLY to colTotals
   * (whenever sum(rowTotals) === sum(colTotals), which callers should
   * ensure upstream). */
  matrix: number[][];
  /** colTotals[j] - actual column sum, measured right after the row-lock
   * discretization pass and BEFORE the compensating-transfer pass that
   * fixes it — diagnostic only, the returned matrix has already closed
   * this gap. */
  colDrift: number[];
}

const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Two-dimensional (biproportional / IPF / RAS) matrix balancing: fills in a
 * matrix from a seed of relative weights so that it simultaneously matches
 * given row totals AND column totals. No general-purpose 2D balancer
 * existed in this codebase before this — the 1D exact-sum allocator
 * `redistributeProportionally` (WorkbookSyncEngine.ts) only ever satisfies
 * one direction at a time; this composes it as the discretization step of
 * a standard RAS algorithm.
 *
 * Produces a matrix that is EXACT in both directions — not just "close" —
 * whenever sum(rowTotals) === sum(colTotals), true by construction for its
 * intended use (a product's annual sales value vs. a month's total sales,
 * both drawn from the same underlying annual total). Row sums are locked
 * first via `redistributeProportionally`; column sums are then fixed with
 * same-row compensating transfers (move N discretization units from an
 * over-target column to an under-target column within one row — net zero
 * for that row, so its already-exact sum never moves). This is what makes
 * both margins exact simultaneously, unlike re-locking columns independently
 * afterwards (which would silently perturb the rows it just fixed). If the
 * grand totals disagree, a real (not just rounding-scale) residual can
 * remain — callers should validate that upstream rather than rely on this
 * function to reconcile it.
 */
export function biproportionalAllocate(
  input: BiproportionalInput,
): BiproportionalResult {
  const { seed, rowTotals, colTotals } = input;
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const precision = input.precision ?? 100;

  const rows = seed.length;
  const cols = rows > 0 ? seed[0].length : 0;

  if (rows === 0 || cols === 0) {
    return { matrix: [], colDrift: colTotals.map(() => 0) };
  }

  // Work in plain floats; only the final discretization passes touch
  // redistributeProportionally's exact-sum rounding.
  let working: number[][] = seed.map((row) =>
    row.map((v) => Math.max(0, v)),
  );

  for (let iter = 0; iter < maxIterations; iter++) {
    // Row-rescale pass.
    for (let r = 0; r < rows; r++) {
      const rowSum = working[r].reduce((s, v) => s + v, 0);
      const target = rowTotals[r] ?? 0;
      if (rowSum > 0) {
        const scale = target / rowSum;
        for (let c = 0; c < cols; c++) working[r][c] *= scale;
      } else if (target > 0) {
        const equalShare = target / cols;
        for (let c = 0; c < cols; c++) working[r][c] = equalShare;
      }
    }
    // Column-rescale pass.
    for (let c = 0; c < cols; c++) {
      let colSum = 0;
      for (let r = 0; r < rows; r++) colSum += working[r][c];
      const target = colTotals[c] ?? 0;
      if (colSum > 0) {
        const scale = target / colSum;
        for (let r = 0; r < rows; r++) working[r][c] *= scale;
      } else if (target > 0) {
        const equalShare = target / rows;
        for (let r = 0; r < rows; r++) working[r][c] = equalShare;
      }
    }
  }

  // Final row-lock discretization: guarantees exact row totals.
  const rowLocked: number[][] = working.map((row, r) =>
    redistributeProportionally(row, rowTotals[r] ?? 0, precision),
  );

  // Diagnostic: column drift measured right after the row lock.
  const colDrift = colTotals.map((target, c) => {
    let colSum = 0;
    for (let r = 0; r < rows; r++) colSum += rowLocked[r][c];
    return target - colSum;
  });

  // Compensating-transfer pass: fix each column's drift by moving whole
  // discretization units between an over-target column and an under-target
  // column WITHIN the same row — that row's total is unaffected (one cell
  // goes down by N units, another goes up by N, net zero), so the row locks
  // from above stay exact while every column also lands exactly on target.
  // Work in integer units (value * precision) to avoid float drift.
  const units: number[][] = rowLocked.map((row) =>
    row.map((v) => Math.round(v * precision)),
  );
  const colTargetUnits = colTotals.map((t) => Math.round((t ?? 0) * precision));
  const colUnitDrift = colTargetUnits.map((target, c) => {
    let sum = 0;
    for (let r = 0; r < rows; r++) sum += units[r][c];
    return target - sum;
  });

  const needCols = colUnitDrift
    .map((d, c) => ({ c, remaining: d }))
    .filter((x) => x.remaining > 0);
  const excessCols = colUnitDrift
    .map((d, c) => ({ c, remaining: -d }))
    .filter((x) => x.remaining > 0);

  let ei = 0;
  for (const need of needCols) {
    while (need.remaining > 0 && ei < excessCols.length) {
      const excess = excessCols[ei];
      if (excess.remaining <= 0) {
        ei++;
        continue;
      }
      const rowOrder = Array.from({ length: rows }, (_, r) => r).sort(
        (a, b) => units[b][excess.c] - units[a][excess.c],
      );
      let want = Math.min(need.remaining, excess.remaining);
      for (const r of rowOrder) {
        if (want <= 0) break;
        const take = Math.min(want, units[r][excess.c]);
        if (take <= 0) continue;
        units[r][excess.c] -= take;
        units[r][need.c] += take;
        want -= take;
        need.remaining -= take;
        excess.remaining -= take;
      }
      // If the excess column ran out of headroom entirely (pathological —
      // every row already at 0), stop trying it to avoid an infinite loop.
      if (want > 0) break;
    }
  }

  const matrix: number[][] = units.map((row) => row.map((v) => v / precision));

  return { matrix, colDrift };
}
