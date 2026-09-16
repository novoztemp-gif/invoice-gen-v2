import { redistributeProportionally } from "@/lib/services/WorkbookSyncEngine";
import { biproportionalAllocate } from "@/lib/utils/biproportionalAllocation";
import { createSeededRandom, hashStringToSeed } from "@/lib/utils/seededRandom";
import {
  MonthlySplitUpMonth,
  MonthlySplitUpParsedInput,
  MonthlySplitUpProduct,
  MonthlySplitUpResult,
  SplitUpMatrix,
} from "./types";

export const DEFAULT_PURCHASE_MARGIN_PERCENT = 5;

/** How far a generated monthly figure is allowed to wander from its target
 * average, as a fraction of that average — ±15%. Applied to both the
 * synthesized margin % (Step 1) and the per-product monthly quantity split
 * (Step 2), so neither one comes out as a suspiciously flat, identical
 * figure every month. */
const REALISTIC_VARIATION = 0.15;

/** Generates `count` values that vary randomly (±REALISTIC_VARIATION)
 * around `average`, then shifts them so their arithmetic mean lands back
 * on `average` EXACTLY — e.g. avg=6.5 might produce
 * [6.1, 6.9, 5.8, 7.0, ...] whose own mean is still exactly 6.5, rather
 * than 12 copies of 6.5 itself. Never returns a negative value. */
function generateRealisticSeries(
  average: number,
  count: number,
  rng: () => number,
): number[] {
  if (average <= 0 || count === 0) return new Array(count).fill(0);
  const raw = Array.from(
    { length: count },
    () => average * (1 + (rng() * 2 - 1) * REALISTIC_VARIATION),
  );
  const rawMean = raw.reduce((s, v) => s + v, 0) / count;
  const shift = average - rawMean;
  return raw.map((v) => Math.max(0, v + shift));
}

/** Step 1: resolve every month's purchase total. Given months keep their
 * own value untouched. Where a month is missing, purchase is estimated
 * from that month's (always-given) sales total and an assumed margin % —
 * but not the SAME flat margin every month (that reads as obviously
 * generated); a realistic-looking series of 12 margins is generated whose
 * own average equals the one the user entered. Rounded to a whole rupee
 * immediately — amounts are whole rupees everywhere in this report, so the
 * synthesized target must already be one too, or the allocation matrix
 * (which sums to a rounded whole number) would never quite match the
 * displayed month total it was built from. */
export function resolveMonthlyPurchaseTotals(
  months: MonthlySplitUpMonth[],
  marginPercent: number,
  rng: () => number = Math.random,
): { months: MonthlySplitUpMonth[]; synthesized: boolean } {
  const synthesized = months.some((m) => m.purchaseTotal === null);
  if (!synthesized) return { months, synthesized };

  const monthlyMargins = generateRealisticSeries(marginPercent, months.length, rng);
  const resolved = months.map((m, i) => {
    if (m.purchaseTotal !== null) return m;
    const ratio = 1 - monthlyMargins[i] / 100;
    return { ...m, purchaseTotal: Math.max(0, Math.round(m.salesTotal * ratio)) };
  });
  return { months: resolved, synthesized: true };
}

/** Step 2: shared quantity matrix. For each product, spread its annual
 * TotalQuantity across the 12 months proportional to each month's
 * (resolved) purchase total — but with independent, realistic per-product
 * noise layered on top of that base shape, so different products don't all
 * move in the exact same near-flat pattern every month (which is what a
 * pure proportional split against nearly-equal monthly totals produces).
 * Allocated in exact quarter-increments (.00/.25/.50/.75) — real stock
 * quantities move in fractional-kg steps, not arbitrary 2-decimal amounts.
 * The row's exact-sum-to-annual-total guarantee holds regardless of how
 * the weights are shaped, since `redistributeProportionally` always sums
 * exactly to the target — only the proportions change. */
export function allocateQuantities(
  products: MonthlySplitUpProduct[],
  months: MonthlySplitUpMonth[],
  rng: () => number = Math.random,
): number[][] {
  const baseWeights = months.map((m) => m.purchaseTotal ?? 0);
  return products.map((p) => {
    const noisyWeights = baseWeights.map((w) =>
      Math.max(0.01, w * (1 + (rng() * 2 - 1) * REALISTIC_VARIATION)),
    );
    return redistributeProportionally(noisyWeights, p.totalQuantity, 4);
  });
}

/** Step 3: within each month (column-wise), split that month's purchase
 * total across products proportional to their quantity share of the month.
 * Allocated in whole rupees — amounts display as clean integers, no
 * decimal noise. */
export function allocatePurchaseAmounts(
  months: MonthlySplitUpMonth[],
  qtyMatrix: number[][],
): number[][] {
  const productCount = qtyMatrix.length;
  const monthCount = months.length;
  const amountByMonth: number[][] = months.map((m) => {
    const weights = qtyMatrix.map((row) => row[m.monthIndex] ?? 0);
    return redistributeProportionally(weights, m.purchaseTotal ?? 0, 1);
  });

  const matrix: number[][] = [];
  for (let p = 0; p < productCount; p++) {
    const row: number[] = [];
    for (let m = 0; m < monthCount; m++) row.push(amountByMonth[m][p]);
    matrix.push(row);
  }
  return matrix;
}

/** Step 4: sales amounts via 2D balancing — row totals = each product's
 * annual taxable value, column totals = each month's sales total.
 * Allocated in whole rupees — amounts display as clean integers, no
 * decimal noise. */
export function allocateSalesAmounts(
  products: MonthlySplitUpProduct[],
  months: MonthlySplitUpMonth[],
  qtyMatrix: number[][],
): number[][] {
  const { matrix } = biproportionalAllocate({
    seed: qtyMatrix,
    rowTotals: products.map((p) => p.taxableValue),
    colTotals: months.map((m) => m.salesTotal),
    precision: 1,
  });
  return matrix;
}

function buildMatrix(qtyMatrix: number[][], amountMatrix: number[][]): SplitUpMatrix {
  return qtyMatrix.map((row, p) =>
    row.map((qty, m) => ({ qty, amount: amountMatrix[p][m] })),
  );
}

export function computeMonthlySplitUp(
  input: MonthlySplitUpParsedInput,
  marginPercent: number = DEFAULT_PURCHASE_MARGIN_PERCENT,
): MonthlySplitUpResult {
  // Seeded from the upload's own data (not wall-clock time), so
  // re-generating or re-downloading the exact same file with the exact
  // same margin always produces the exact same "realistic" numbers —
  // deterministic, not flaky, even though it looks randomized.
  const seed = hashStringToSeed(
    `${input.financialYear}|${input.products.length}|${input.totals.taxableValue}|${marginPercent}`,
  );
  const rng = createSeededRandom(seed);

  const { months: resolvedMonths, synthesized } = resolveMonthlyPurchaseTotals(
    input.months,
    marginPercent,
    rng,
  );

  const qtyMatrix = allocateQuantities(input.products, resolvedMonths, rng);
  const purchaseAmountMatrix = allocatePurchaseAmounts(resolvedMonths, qtyMatrix);
  const salesAmountMatrix = allocateSalesAmounts(
    input.products,
    resolvedMonths,
    qtyMatrix,
  );

  return {
    financialYear: input.financialYear,
    products: input.products,
    months: resolvedMonths,
    purchaseMatrix: buildMatrix(qtyMatrix, purchaseAmountMatrix),
    salesMatrix: buildMatrix(qtyMatrix, salesAmountMatrix),
    purchaseTotalsWereSynthesized: synthesized,
    purchaseMarginPercentUsed: marginPercent,
  };
}
