import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Root cause confirmed on a real 545-invoice batch (GLOBAL semantics): two
 * cheap, low-`lineFloor` products systematically overshoot their occurrence
 * target because they keep winning every invoice's budget-exempt
 * "guaranteed" first line, while lower-percentage products systematically
 * undershoot. `repairOccurrenceDeviations` already existed to swap lines
 * from over-target products onto under-target ones post-generation, but its
 * swap search required the replacement product's quantity/rate to
 * reproduce the over-product's EXACT original rupee line amount
 * (`findExactLineForAmount`) — a narrow, often-unsatisfiable condition
 * across products with different configured rate/quantity ranges, which is
 * why real batches kept shipping with large unrepaired deviations despite
 * this pass already running every time.
 *
 * This fixture makes that failure concrete: OVER's line amount (₹100) is
 * mathematically UNREACHABLE by UNDER's own configured range (rate
 * 41-43 x qty 2-3 — verified by hand: every combination lands on 97 or
 * further away, never exactly 100), while BUDDY has a wide, flexible range
 * so it can always absorb whatever small residual a swap leaves behind.
 */

function product(
  id: string,
  occurrencePercentage: number,
  ranges: { rateMin: string; rateMax: string; qtyMin: string; qtyMax: string },
): any {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayRateMin: ranges.rateMin,
    perDayRateMax: ranges.rateMax,
    perDayQtyMin: ranges.qtyMin,
    perDayQtyMax: ranges.qtyMax,
    occurrencePercentage,
    category: "Meat",
  };
}

const OVER = product("OVER", 25, {
  rateMin: "1",
  rateMax: "150",
  qtyMin: "1",
  qtyMax: "200",
});
// Narrow/awkward range: no (integer rate, quarter-kg qty) combination in
// this range reproduces exactly ₹100 (verified by hand — closest is ₹97).
const UNDER = product("UNDER", 25, {
  rateMin: "41",
  rateMax: "43",
  qtyMin: "2",
  qtyMax: "3",
});
const BUDDY = product("BUDDY", 50, {
  rateMin: "1",
  rateMax: "150",
  qtyMin: "1",
  qtyMax: "200",
});
const products = [OVER, UNDER, BUDDY];
const productConfigById = new Map(products.map((p) => [p.product_id, p]));

const batch = {
  id: "batch-1",
  products,
  category_allocation: null,
  occurrence_semantics: "GLOBAL",
} as any;

// 4 invoices x 2 lines = 8 slots -> targets (25%/25%/50% of 8): OVER=2,
// UNDER=2, BUDDY=4. Every invoice actually built as (OVER, BUDDY), so
// actual is OVER=4 (+2 over target), UNDER=0 (-2 under target), BUDDY=4
// (exact) — the same shape as the real bug: a cheap/flexible product
// overshooting while a specific other product undershoots by the same
// amount.
function buildInvoices(): any[] {
  return [1, 2, 3, 4].map((n) => ({
    invoice_number: `TST-${n}`,
    invoice_date: "2026-01-01",
    category_key: "Meat",
    total_amount: 200,
    products: [
      { product_id: "OVER", quantity: 10, rate: 10, amount: 100 },
      { product_id: "BUDDY", quantity: 10, rate: 10, amount: 100 },
    ],
  }));
}

function countActual(invoices: any[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const inv of invoices) {
    for (const line of inv.products) {
      counts.set(line.product_id, (counts.get(line.product_id) || 0) + 1);
    }
  }
  return counts;
}

describe("InvoiceEngine.repairOccurrenceDeviations — converges to exact targets even when the replacement product can't reproduce the exact original line amount", () => {
  it("closes OVER from 4->2 and UNDER from 0->2, matching target exactly", () => {
    const invoices = buildInvoices();
    const Engine = InvoiceEngine as any;

    Engine.repairOccurrenceDeviations(
      invoices,
      batch,
      productConfigById,
      new Map([["dummy", 1]]), // only gates whether repair runs at all
      undefined,
    );

    const actual = countActual(invoices);
    expect(actual.get("OVER")).toBe(2);
    expect(actual.get("UNDER")).toBe(2);
    expect(actual.get("BUDDY")).toBe(4);
  });

  it("never changes any invoice's total_amount, and every invoice's lines still sum to it", () => {
    const invoices = buildInvoices();
    const totalsBefore = invoices.map((inv) => inv.total_amount);
    const Engine = InvoiceEngine as any;

    Engine.repairOccurrenceDeviations(
      invoices,
      batch,
      productConfigById,
      new Map([["dummy", 1]]),
      undefined,
    );

    expect(invoices.map((inv) => inv.total_amount)).toEqual(totalsBefore);
    for (const inv of invoices) {
      const lineSum = inv.products.reduce(
        (s: number, p: any) => s + p.amount,
        0,
      );
      expect(lineSum).toBe(inv.total_amount);
    }
  });
});

/**
 * Root cause of a real, confirmed live failure: a 3479-invoice By Category
 * Purchase batch kept failing occurrence validation with large residual
 * deviations (target 37, actual 61-63) even after raising MAX_REPAIR_PASSES
 * and indexing the repair pass for speed — the pass loop was exhausting
 * itself (or exiting on zero swaps) without ever closing the gap.
 *
 * Traced to the swap's own solve: it required the replacement (under-
 * target) product's line to land AT OR UNDER the vacated (over-target)
 * product's line amount (`solveLineForTargetCapped`'s preferFloor
 * semantics), on the assumption that only one small, fixed neighboring
 * line would ever absorb the residual. Two products in the same broad
 * category can legitimately sit at very different price points (e.g. a
 * cheap cut vs. an expensive one, both still "Meat") — the moment the
 * under-target product's own cheapest achievable line already exceeded the
 * over-target line's amount, EVERY swap attempt for that pair failed,
 * permanently, no matter how many passes ran.
 *
 * This fixture makes that concrete: UNDER's rate/quantity range is fixed
 * (500 x 2 = a ₹1000 floor with no way to go lower), vastly more than
 * OVER's fixed ₹10 line — under the old preferFloor-only solve this pair
 * could never swap at all. The fix uses an ordinary closest-match solve for
 * the replacement (lands wherever the product's own range allows, not just
 * at-or-under) and searches every other line on the invoice — not just one
 * fixed neighbor — for one that can absorb whatever residual results.
 */
describe("InvoiceEngine.repairOccurrenceDeviations — converges even when the under-target product's own price floor exceeds the over-target product's line amount", () => {
  function product(
    id: string,
    occurrencePercentage: number,
    ranges: { rateMin: string; rateMax: string; qtyMin: string; qtyMax: string },
  ): any {
    return {
      product_id: id,
      product_name: id,
      hsn_code: "0207",
      unit_of_measure: "kg",
      perDayRateMin: ranges.rateMin,
      perDayRateMax: ranges.rateMax,
      perDayQtyMin: ranges.qtyMin,
      perDayQtyMax: ranges.qtyMax,
      occurrencePercentage,
      category: "Meat",
    };
  }

  // Fixed at exactly ₹10 (rate 10 x qty 1) — no flex at all.
  const OVER = product("OVER", 10, {
    rateMin: "10",
    rateMax: "10",
    qtyMin: "1",
    qtyMax: "1",
  });
  // Fixed at exactly ₹1000 (rate 500 x qty 2) — no combination anywhere
  // near OVER's ₹10 line is reachable.
  const UNDER = product("UNDER", 40, {
    rateMin: "500",
    rateMax: "500",
    qtyMin: "2",
    qtyMax: "2",
  });
  // Wide, flexible range so it can absorb whatever large residual a
  // successful swap produces.
  const BUDDY = product("BUDDY", 50, {
    rateMin: "1",
    rateMax: "1000",
    qtyMin: "1",
    qtyMax: "200",
  });
  const products = [OVER, UNDER, BUDDY];
  const productConfigById = new Map(products.map((p) => [p.product_id, p]));

  const batch = {
    id: "batch-2",
    products,
    category_allocation: null,
    occurrence_semantics: "GLOBAL",
  } as any;

  const INVOICE_COUNT = 50;

  // 50 invoices x 2 lines = 100 slots -> targets (10%/40%/50% of 100):
  // OVER=10, UNDER=40, BUDDY=50. Every invoice built as (OVER, BUDDY), so
  // actual is OVER=50 (+40 over target), UNDER=0 (-40 under target),
  // BUDDY=50 (exact) — same shape as the real failure (a small-target
  // product massively over-represented, a specific other product
  // correspondingly under-represented).
  function buildInvoices(): any[] {
    return Array.from({ length: INVOICE_COUNT }, (_, i) => ({
      invoice_number: `TST-${i + 1}`,
      invoice_date: "2026-01-01",
      category_key: "Meat",
      total_amount: 1010,
      products: [
        { product_id: "OVER", quantity: 1, rate: 10, amount: 10 },
        { product_id: "BUDDY", quantity: 100, rate: 10, amount: 1000 },
      ],
    }));
  }

  function countActual(invoices: any[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const inv of invoices) {
      for (const line of inv.products) {
        counts.set(line.product_id, (counts.get(line.product_id) || 0) + 1);
      }
    }
    return counts;
  }

  it("closes OVER from 50->10 and UNDER from 0->40, matching target exactly", () => {
    const invoices = buildInvoices();
    const Engine = InvoiceEngine as any;

    Engine.repairOccurrenceDeviations(
      invoices,
      batch,
      productConfigById,
      new Map([["dummy", 1]]),
      undefined,
    );

    const actual = countActual(invoices);
    expect(actual.get("OVER")).toBe(10);
    expect(actual.get("UNDER")).toBe(40);
    expect(actual.get("BUDDY")).toBe(50);
  });

  it("never changes any invoice's total_amount, and every invoice's lines still sum to it exactly", () => {
    const invoices = buildInvoices();
    const totalsBefore = invoices.map((inv) => inv.total_amount);
    const Engine = InvoiceEngine as any;

    Engine.repairOccurrenceDeviations(
      invoices,
      batch,
      productConfigById,
      new Map([["dummy", 1]]),
      undefined,
    );

    expect(invoices.map((inv) => inv.total_amount)).toEqual(totalsBefore);
    for (const inv of invoices) {
      const lineSum = inv.products.reduce(
        (s: number, p: any) => s + p.amount,
        0,
      );
      expect(lineSum).toBe(inv.total_amount);
    }
  });

  it("never produces a duplicate product line on the same invoice", () => {
    const invoices = buildInvoices();
    const Engine = InvoiceEngine as any;

    Engine.repairOccurrenceDeviations(
      invoices,
      batch,
      productConfigById,
      new Map([["dummy", 1]]),
      undefined,
    );

    for (const inv of invoices) {
      const ids = inv.products.map((p: any) => p.product_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
