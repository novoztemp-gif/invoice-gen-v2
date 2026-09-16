import { describe, expect, it } from "vitest";
import { computeMonthlySplitUp } from "./MonthlySplitUpEngine";
import { MonthlySplitUpParsedInput } from "./types";

function makeMonths(
  salesTotals: number[],
  purchaseTotals: (number | null)[] = salesTotals.map((s) => s * 0.95),
) {
  return salesTotals.map((salesTotal, i) => ({
    label: `M${i + 1}`,
    monthIndex: i,
    purchaseTotal: purchaseTotals[i],
    salesTotal,
  }));
}

const PRODUCTS = [
  { hsnCode: "1001", description: "PRODUCT A", uqc: "KGS", totalQuantity: 1200, taxableValue: 240000 },
  { hsnCode: "1002", description: "PRODUCT B", uqc: "KGS", taxableValue: 360000, totalQuantity: 800 },
];

function makeInput(
  salesTotals: number[],
  purchaseTotals?: (number | null)[],
): MonthlySplitUpParsedInput {
  const months = makeMonths(salesTotals, purchaseTotals);
  return {
    financialYear: "2024-25",
    products: PRODUCTS,
    months,
    totals: {
      totalQuantity: PRODUCTS.reduce((s, p) => s + p.totalQuantity, 0),
      taxableValue: PRODUCTS.reduce((s, p) => s + p.taxableValue, 0),
      purchaseTotal: months.reduce((s, m) => s + (m.purchaseTotal ?? 0), 0),
      salesTotal: salesTotals.reduce((s, v) => s + v, 0),
      grossProfit: 0,
    },
  };
}

// 12 months, sums to the products' combined taxable value (600000).
const SALES_TOTALS = [
  60000, 55000, 45000, 50000, 40000, 48000, 52000, 47000, 43000, 46000,
  57000, 57000,
];

describe("computeMonthlySplitUp", () => {
  it("every product row of the sales matrix sums to that product's annual taxable value", () => {
    const result = computeMonthlySplitUp(makeInput(SALES_TOTALS));

    result.products.forEach((p, pIdx) => {
      const rowSum = result.salesMatrix[pIdx].reduce((s, c) => s + c.amount, 0);
      expect(rowSum).toBe(p.taxableValue);
    });
  });

  it("every month column of the sales matrix sums to that month's sales total", () => {
    const result = computeMonthlySplitUp(makeInput(SALES_TOTALS));

    result.months.forEach((m, mIdx) => {
      const colSum = result.salesMatrix.reduce(
        (s, row) => s + row[mIdx].amount,
        0,
      );
      // Column cleanup is exact by construction (redistributeProportionally
      // against the real target), so this should match exactly.
      expect(colSum).toBe(m.salesTotal);
    });
  });

  it("every month column of the purchase matrix sums to that month's resolved purchase total", () => {
    const result = computeMonthlySplitUp(makeInput(SALES_TOTALS));

    result.months.forEach((m, mIdx) => {
      const colSum = result.purchaseMatrix.reduce(
        (s, row) => s + row[mIdx].amount,
        0,
      );
      expect(colSum).toBe(m.purchaseTotal);
    });
  });

  it("purchase qty and sales qty are identical at every product x month cell", () => {
    const result = computeMonthlySplitUp(makeInput(SALES_TOTALS));

    result.products.forEach((_, pIdx) => {
      result.months.forEach((_, mIdx) => {
        expect(result.purchaseMatrix[pIdx][mIdx].qty).toBe(
          result.salesMatrix[pIdx][mIdx].qty,
        );
      });
    });
  });

  it("each product's total quantity across all months equals its annual total quantity", () => {
    const result = computeMonthlySplitUp(makeInput(SALES_TOTALS));

    result.products.forEach((p, pIdx) => {
      const qtySum = result.salesMatrix[pIdx].reduce((s, c) => s + c.qty, 0);
      expect(qtySum).toBe(p.totalQuantity);
    });
  });

  it("monthly quantities vary realistically — not a suspiciously flat, near-identical figure every month, and not identical in shape across different products", () => {
    // Reported bug: monthly qty was proportional to the (nearly flat)
    // aggregate monthly total for every product, so every product's
    // 12-month split looked like the same smooth curve just rescaled.
    const result = computeMonthlySplitUp(makeInput(SALES_TOTALS));

    const qtyA = result.salesMatrix[0].map((c) => c.qty);
    const qtyB = result.salesMatrix[1].map((c) => c.qty);

    // Genuine month-to-month spread within one product (not all ~100.00).
    const spread = (vals: number[]) => Math.max(...vals) - Math.min(...vals);
    expect(spread(qtyA)).toBeGreaterThan(1);
    expect(spread(qtyB)).toBeGreaterThan(1);

    // Different products don't share the exact same relative shape — if
    // they did, qtyA[i]/qtyA[j] would equal qtyB[i]/qtyB[j] for every pair,
    // since both would just be the same normalized curve scaled by a
    // constant. Confirm at least one ratio genuinely differs.
    const ratios = qtyA.map((v, i) => (qtyB[i] > 0 ? v / qtyB[i] : 0));
    const distinctRatios = new Set(ratios.map((r) => Math.round(r * 1000)));
    expect(distinctRatios.size).toBeGreaterThan(1);
  });

  it("synthesizes purchase totals that vary realistically around the assumed margin, not an identical flat ratio every month", () => {
    const purchaseTotals: (number | null)[] = new Array(12).fill(null);
    const result = computeMonthlySplitUp(
      makeInput(SALES_TOTALS, purchaseTotals),
      10, // 10% margin
    );

    expect(result.purchaseTotalsWereSynthesized).toBe(true);
    expect(result.purchaseMarginPercentUsed).toBe(10);

    const impliedMargins = result.months.map(
      (m, i) => ((SALES_TOTALS[i] - (m.purchaseTotal ?? 0)) / SALES_TOTALS[i]) * 100,
    );
    // Genuine month-to-month variation — not 12 copies of the same number.
    expect(new Set(impliedMargins.map((v) => Math.round(v * 100))).size).toBeGreaterThan(1);
    // Every month stays within the ±15% realistic-variation band around 10%.
    impliedMargins.forEach((margin) => {
      expect(margin).toBeGreaterThan(10 * 0.8);
      expect(margin).toBeLessThan(10 * 1.2);
    });
    // The 12 generated margins average back out to the requested 10%.
    const avgMargin = impliedMargins.reduce((s, v) => s + v, 0) / impliedMargins.length;
    expect(avgMargin).toBeCloseTo(10, 0);
  });

  it("is deterministic — the same input and margin always produce the same synthesized values", () => {
    const purchaseTotals: (number | null)[] = new Array(12).fill(null);
    const r1 = computeMonthlySplitUp(makeInput(SALES_TOTALS, purchaseTotals), 10);
    const r2 = computeMonthlySplitUp(makeInput(SALES_TOTALS, purchaseTotals), 10);
    expect(r1.months.map((m) => m.purchaseTotal)).toEqual(
      r2.months.map((m) => m.purchaseTotal),
    );
    expect(r1.salesMatrix).toEqual(r2.salesMatrix);
  });

  it("does not mark purchase as synthesized when every month has a real purchase figure", () => {
    const result = computeMonthlySplitUp(makeInput(SALES_TOTALS));
    expect(result.purchaseTotalsWereSynthesized).toBe(false);
  });

  it("synthesizes only the missing months when purchase is partially given, leaving given months exactly untouched", () => {
    // Given months use a distinct 90% ratio; missing months get a varying
    // series averaging to the 5% margin instead — proves the given values
    // survive byte-for-byte and only the blanks are (realistically) filled.
    const givenPurchase = SALES_TOTALS.map((s) => s * 0.9);
    const purchaseTotals: (number | null)[] = givenPurchase.map((v, i) =>
      i < 6 ? v : null,
    );
    const result = computeMonthlySplitUp(
      makeInput(SALES_TOTALS, purchaseTotals),
      5,
    );

    expect(result.purchaseTotalsWereSynthesized).toBe(true);
    result.months.slice(0, 6).forEach((m, i) => {
      expect(m.purchaseTotal).toBe(givenPurchase[i]);
    });

    const synthesizedMargins = result.months.slice(6).map(
      (m, idx) => {
        const i = idx + 6;
        return ((SALES_TOTALS[i] - (m.purchaseTotal ?? 0)) / SALES_TOTALS[i]) * 100;
      },
    );
    expect(new Set(synthesizedMargins.map((v) => Math.round(v * 100))).size).toBeGreaterThan(1);
    synthesizedMargins.forEach((margin) => {
      expect(margin).toBeGreaterThan(5 * 0.8);
      expect(margin).toBeLessThan(5 * 1.2);
    });
  });
});
