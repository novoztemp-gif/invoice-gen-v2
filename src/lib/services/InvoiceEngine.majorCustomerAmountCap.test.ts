import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";
import type { InvoiceBatch } from "./InvoiceEngine";

/**
 * Real, reported bug — a Purchase batch's "Major Customer Exact Balance
 * Correction Guard" (closes the gap between what a major customer's
 * invoices actually generated and their configured total) could push an
 * individual invoice above the major customer's own configured
 * max_invoice_amount, with nothing catching it. Confirmed on a real batch:
 * multiple invoices for the same major customer landed at ₹11,000 against a
 * configured ₹9,999 max, discovered only at Finalize time (a strict,
 * non-grandfathered gate).
 *
 * Root cause confirmed directly: with a product quantity that does NOT
 * evenly divide the per-invoice target (e.g. 7kg against a ₹9000 target),
 * the per-invoice build step floors down to the nearest achievable rate
 * (it's floor-safe, never overshoots its OWN target) — but that leaves a
 * real, positive aggregate shortfall across a major customer's invoices.
 * The (not floor-safe) Exact Balance Correction Guard then rounds UP to
 * the nearest achievable grid point while closing that shortfall, which
 * can land the invoice it touches above the configured max. Reproduced
 * directly (before the fix): with the fixture below, generation threw
 * "Major Customer invoice exceeds configured maximum" from STEP 5's own
 * pre-existing guard on 23 of 40 runs.
 *
 * Fixed by adding a final hard-cap safety pass right after the correction
 * guard (mirroring the identical, pre-existing fix already on the Sales
 * side of the same correction guard) that trims any invoice still over
 * mMaxLimit back down with preferFloor.
 */

const Engine = InvoiceEngine as any;
const START_DATE = new Date(2026, 0, 1);
const NUM_DAYS = 30;

function makeBatch(overrides: Partial<InvoiceBatch> = {}): InvoiceBatch {
  return {
    id: "batch-1",
    issuing_company_id: "co-1",
    financial_year: "2026-27",
    invoice_date_from: "2026-01-01",
    invoice_date_to: "2026-01-30",
    minimum_invoice_amount: 1000,
    maximum_invoice_amount: 100000,
    total_amount: 0,
    products: [],
    selected_customers: [],
    major_customers: [],
    batch_type: "PURCHASE",
    ...overrides,
  };
}

function categoryMap(ids: string[]): Map<string, "Fruits" | "Meat"> {
  return new Map(ids.map((id) => [id, "Meat" as const]));
}

describe("Purchase Major Customer invoices never exceed their configured max (regression)", () => {
  it("no successful run ever leaves a major customer invoice over its configured max, and the specific over-cap error never occurs", () => {
    const M_INV_COUNT = 3;
    const AVG_BUDGET = 9000;
    // Tight margin above the average — this is what turns the correction
    // guard's routine rounding-up-to-the-nearest-achievable-grid-point
    // behavior into an actual over-cap violation instead of a harmless
    // few-rupee overshoot that still fits comfortably under the max.
    const M_MAX_LIMIT = AVG_BUDGET + 3;
    const M_AMOUNT = AVG_BUDGET * M_INV_COUNT;
    const NORMAL_AMOUNT = 5000;

    const batch = makeBatch({
      total_amount: M_AMOUNT + NORMAL_AMOUNT,
      products: [
        {
          // 7kg does not evenly divide the ₹9000 per-invoice target at any
          // whole-integer rate (9000/7 is not an integer) — this is what
          // forces the per-invoice build to floor down, leaving real
          // aggregate drift for the correction guard to close.
          product_id: "prod-meat-1",
          product_name: "Chicken",
          hsn_code: "0207",
          unit_of_measure: "kg",
          perDayQtyMin: "7",
          perDayQtyMax: "7",
          perDayRateMin: "50",
          perDayRateMax: "2000",
          occurrencePercentage: 70,
          category: "Meat",
        } as any,
        {
          // A second, generously-ranged product so normal (non-major)
          // invoices exist to absorb residual drift elsewhere in the
          // batch — isolating the assertion to the major customer's own
          // cap, not an unrelated whole-batch-total rounding gap.
          product_id: "prod-meat-2",
          product_name: "Mutton",
          hsn_code: "0204",
          unit_of_measure: "kg",
          perDayQtyMin: "10",
          perDayQtyMax: "100",
          perDayRateMin: "10",
          perDayRateMax: "500",
          occurrencePercentage: 30,
          category: "Meat",
        } as any,
      ],
      selected_customers: ["norm-1", "norm-2"],
      major_customers: [
        {
          customer_id: "maj-a",
          amount: M_AMOUNT,
          invoice_count: M_INV_COUNT,
          max_invoice_amount: M_MAX_LIMIT,
        },
      ],
    });

    // This fixture is deliberately extreme (a quantity that can't evenly
    // reach the target, at a cap only ₹3 above the average) — real,
    // unrelated guards elsewhere (whole-batch-total exactness, this
    // customer's own ±5 balancing tolerance) sometimes legitimately
    // reject a run outright. That's correct behavior for a genuinely
    // tight configuration, not the bug under test here. What must NEVER
    // happen, on any run, is specifically the "exceeds configured
    // maximum" error — the fix's whole job is making sure no invoice is
    // ever left in that state for STEP 5's guard to catch.
    let successfulRuns = 0;
    for (let run = 0; run < 40; run++) {
      let invoices: any[];
      try {
        invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
          batch,
          NUM_DAYS,
          START_DATE,
          1,
          undefined,
          categoryMap(["maj-a"]),
        );
      } catch (err: any) {
        expect(err.message).not.toContain("exceeds configured maximum");
        continue;
      }
      successfulRuns++;

      const majorInvoices = invoices.filter(
        (inv: any) => inv.customer_id === "maj-a",
      );
      expect(majorInvoices.length).toBe(M_INV_COUNT);

      for (const inv of majorInvoices) {
        const lineSum = Math.round(
          inv.products.reduce(
            (s: number, p: any) => s + Math.round(p.amount || 0),
            0,
          ),
        );
        // The fix under test: no invoice may ever exceed the configured
        // max_invoice_amount, no matter how the drift-closing rounds.
        expect(inv.total_amount).toBeLessThanOrEqual(M_MAX_LIMIT + 0.5);
        // Header total must still agree with what the lines actually sum
        // to — the trim-down must recompute total_amount, not just mutate
        // the line in isolation.
        expect(Math.abs(lineSum - inv.total_amount)).toBeLessThanOrEqual(0.5);
      }
    }

    // Sanity check on the fixture itself — if generation never actually
    // succeeded on any run, this test isn't exercising the cap invariant
    // at all, only unrelated infeasibility guards.
    expect(successfulRuns).toBeGreaterThan(0);
  });
});
