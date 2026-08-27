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
