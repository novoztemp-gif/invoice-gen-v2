import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";
import { calculateQuotaAllocation } from "./ProductOccurrenceQuotaService";

/**
 * Root cause of a real, confirmed live failure: a 348-invoice CATEGORY
 * batch kept failing occurrence validation with LARGE, systematic
 * deviations — every under-target product concentrated in one category,
 * every over-target product in the other — that repairOccurrenceDeviations
 * could never close no matter how many passes ran (confirmed via a
 * diagnostic: 9/9 under-target products had ZERO same-category over-target
 * counterpart to swap from). Repair only ever moves slots WITHIN a
 * category by design (an invoice's category is fixed at generation time),
 * so a whole-category imbalance at the TARGET level is fundamentally
 * unfixable there — the bug had to be upstream, in target calculation
 * itself.
 *
 * Traced to computeCategoryCapacityAwareTargets: pickCategoryFromLedger
 * assigns each invoice's category via a WEIGHTED RANDOM draw against the
 * configured category_allocation split — which can (and, confirmed here,
 * does) realize a meaningfully different split than configured by chance,
 * especially at smaller batch sizes where statistical variance is
 * proportionally larger. computeCategoryCapacityAwareTargets sized each
 * category's total product-target budget (catSlotsTarget) from
 * catInvoiceTarget — what the CONFIGURED percentages implied the category
 * should get — instead of the category's REAL, measured invoice count,
 * even though the neighboring avgLinesForCat calculation right next to it
 * already correctly used real data. Whenever the realized split drifted
 * from config, a category's own product targets summed to something other
 * than what that category actually holds — the under-realized category's
 * targets summed too HIGH relative to its real capacity (manifesting as
 * every one of its products reading under-target), the over-realized
 * category's summed too LOW (every product over-target) — with no
 * same-category repair possible either direction.
 */
describe("InvoiceEngine.computeCategoryCapacityAwareTargets — per-category conservation when the realized category split diverges from configured category_allocation", () => {
  function product(
    id: string,
    category: "Meat" | "Fruits",
    occurrencePercentage: number,
  ): any {
    return {
      product_id: id,
      product_name: id,
      hsn_code: "0207",
      unit_of_measure: "kg",
      perDayRateMin: "10",
      perDayRateMax: "10",
      perDayQtyMin: "1",
      perDayQtyMax: "1",
      occurrencePercentage,
      category,
    };
  }

  // Configured as Meat:70 / Fruits:30 — but the fixture's actual invoices
  // (below) realize a 50/50 split instead, simulating pickCategoryFromLedger's
  // weighted-random draw landing meaningfully off the configured target, as
  // it can at smaller batch sizes.
  const M1 = product("M1", "Meat", 60);
  const M2 = product("M2", "Meat", 40);
  const F1 = product("F1", "Fruits", 50);
  const F2 = product("F2", "Fruits", 50);
  const products = [M1, M2, F1, F2];

  const MEAT_REAL_INVOICES = 50;
  const FRUITS_REAL_INVOICES = 50;
  const TOTAL_INVOICES = MEAT_REAL_INVOICES + FRUITS_REAL_INVOICES;

  // One line per invoice, alternating which category's product it carries
  // — real placement doesn't matter for this test (only the resulting
  // per-category invoice/line counts do), so an even/arbitrary split
  // within each category is fine.
  function buildInvoices(): any[] {
    const meatInvoices = Array.from({ length: MEAT_REAL_INVOICES }, (_, i) => ({
      invoice_number: `M-${i + 1}`,
      invoice_date: "2026-01-01",
      category_key: "Meat",
      products: [
        {
          product_id: i % 2 === 0 ? "M1" : "M2",
          quantity: 1,
          rate: 10,
          amount: 10,
        },
      ],
    }));
    const fruitsInvoices = Array.from(
      { length: FRUITS_REAL_INVOICES },
      (_, i) => ({
        invoice_number: `F-${i + 1}`,
        invoice_date: "2026-01-01",
        category_key: "Fruits",
        products: [
          {
            product_id: i % 2 === 0 ? "F1" : "F2",
            quantity: 1,
            rate: 10,
            amount: 10,
          },
        ],
      }),
    );
    return [...meatInvoices, ...fruitsInvoices];
  }

  it("each category's product targets sum to exactly that category's real total lines, not the configured-implied count", () => {
    const invoices = buildInvoices();
    const quotaAllocation = calculateQuotaAllocation(
      products,
      TOTAL_INVOICES,
      { Meat: 70, Fruits: 30 },
      "CATEGORY",
    );
    expect(quotaAllocation.valid).toBe(true);

    const Engine = InvoiceEngine as any;
    const targets: Map<string, number> = Engine.computeCategoryCapacityAwareTargets(
      quotaAllocation,
      products,
      invoices,
      true,
      new Set(["Meat", "Fruits"]),
      undefined,
      { Meat: 70, Fruits: 30 },
    );

    const meatSum = (targets.get("M1") || 0) + (targets.get("M2") || 0);
    const fruitsSum = (targets.get("F1") || 0) + (targets.get("F2") || 0);

    // The configured split implied Meat=70/Fruits=30, but the real
    // invoices realized 50/50 — targets must follow reality, not the
    // configured estimate, or repair has nothing valid to converge
    // toward.
    expect(meatSum).toBe(MEAT_REAL_INVOICES);
    expect(fruitsSum).toBe(FRUITS_REAL_INVOICES);
  });
});
