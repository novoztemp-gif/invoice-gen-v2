import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Focused, deterministic-ish unit test on the EXACT mechanism changed —
 * `generatePurchaseInvoiceSplitupsInternal`'s per-invoice product-line
 * COUNT draw (`targetSubsetCount`), called directly with a pre-seeded
 * `occurrenceLedger` (a parameter this function already accepts) that
 * simulates a category whose quota is already mostly exhausted by earlier
 * invoices — the exact real-world condition that produced the client's
 * reported failure.
 *
 * `InvoiceEngine.occurrenceQuotaScarcity.test.ts` tries to reproduce this
 * through the FULL pipeline (generateAndSaveInvoices, ~500 invoices) but
 * that pipeline's own 30-attempt retry + 5-pass repair turned out robust
 * enough to absorb the bias on every fixture shape tried within a
 * reasonable test budget — it never actually caught the regression before
 * this fix went in, so it doesn't prove much on its own. This test isolates
 * the changed code directly instead, sidestepping that retry/repair noise.
 *
 * Setup: 10 products in one category. The ledger says only ONE (M1) has
 * any quota left (remaining=5); the other nine are already at target
 * (remaining=0) — exactly what "earlier invoices already consumed this
 * category's quota" looks like mid-generation. Before the fix,
 * `targetSubsetCount` was a flat random 3-8 with no awareness of this —
 * every invoice would force 3-8 lines regardless, guaranteeing several of
 * the nine already-exhausted products get pulled onto every invoice. After
 * the fix, the draw is capped by how many products still have real quota,
 * so invoices should stay close to 1 line (just M1) until ITS quota also
 * runs out.
 */
function meatProduct(id: string) {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "50",
    perDayRateMin: "5",
    perDayRateMax: "10",
    occurrencePercentage: 10,
    category: "Meat",
  };
}

function makeBatch() {
  return {
    id: "batch-1",
    issuing_company_id: "co-1",
    financial_year: "2026-27",
    invoice_date_from: "2026-01-01",
    invoice_date_to: "2026-01-10",
    minimum_invoice_amount: 100,
    maximum_invoice_amount: 2000,
    total_amount: 10000,
    products: Array.from({ length: 10 }, (_, i) => meatProduct(`M${i + 1}`)),
    selected_customers: [],
    major_customers: [],
    batch_type: "PURCHASE",
    receiving_company_id: "sup-1",
  } as any;
}

describe("generatePurchaseInvoiceSplitupsInternal — per-invoice line count respects remaining occurrence quota", () => {
  it("stays close to 1 line/invoice (just the one product with real quota left) instead of forcing 3-8 from already-exhausted products", () => {
    const Engine = InvoiceEngine as any;
    const batch = makeBatch();

    // M1 still has quota; M2-M10 are already exhausted (target already
    // met by earlier invoices in the real batch this simulates).
    const occurrenceLedger = new Map<string, number>([
      ["M1", 5],
      ["M2", 0],
      ["M3", 0],
      ["M4", 0],
      ["M5", 0],
      ["M6", 0],
      ["M7", 0],
      ["M8", 0],
      ["M9", 0],
      ["M10", 0],
    ]);

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      10,
      new Date(2026, 0, 1),
      1,
      undefined, // monthlyQuantities
      undefined, // supplierCategoryMap
      occurrenceLedger,
      undefined, // categoryLedger
    );

    expect(invoices.length).toBeGreaterThan(0);

    // While M1 still had quota (its own target of 5), invoices should have
    // drawn ~1 line, not 3-8 — the exhausted M2-M10 should barely appear,
    // nowhere close to the 3-8 lines/invoice they'd get without the cap.
    const exhaustedProductLineCount = invoices.reduce(
      (sum: number, inv: any) =>
        sum +
        (inv.products || []).filter((p: any) => p.product_id !== "M1").length,
      0,
    );

    // Without the fix, EVERY invoice forces 3-8 lines regardless of quota,
    // so with 10 products and ~5+ invoices, the nine exhausted products
    // would rack up well over 15-20 combined appearances. With the fix,
    // capped at floor-1 once quota is gone, this should stay small —
    // roughly bounded by (invoices generated - M1's own quota of 5).
    expect(exhaustedProductLineCount).toBeLessThan(invoices.length * 1.5);
  });
});
