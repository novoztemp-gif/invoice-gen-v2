import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Root cause of a real, confirmed live failure: every occurrence-repair fix
 * made to InvoiceEngine this session (price-floor incompatibility,
 * cross-invoice shed+fill, per-category conservation) only ever applied to
 * Purchase generation — repairOccurrenceDeviations had exactly ONE call
 * site, inside generatePurchaseInvoiceSplitupsInternal.
 * generateInvoiceSplitupsInternal (the Sales-side generator) never called
 * it at all, so every one of those fixes had zero effect on Sales batches.
 * Confirmed on a real 662-invoice CATEGORY Sales batch: one product hit
 * target 55, actual 409 (+354 deviation) with nothing to correct it.
 *
 * This doesn't re-verify the repair ALGORITHM itself (already covered by
 * InvoiceEngine.occurrenceRepairConvergence.test.ts and
 * InvoiceEngine.categoryTargetConservation.test.ts, both caller-agnostic)
 * — it only proves generateInvoiceSplitupsInternal actually INVOKES it
 * now, via the same diagnostic breadcrumb the real production error
 * message surfaces (setOccurrenceRepairDiagnostic): if repair genuinely
 * ran, `(invoices as any).__occurrenceRepairDiagnostic` is populated
 * (whatever the outcome); if the call site were still missing, it would
 * stay undefined, exactly as it did on the real batch that reported no
 * "Repair:" line at all.
 */
describe("InvoiceEngine.generateInvoiceSplitupsInternal (Sales) — actually invokes repairOccurrenceDeviations", () => {
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
      perDayQtyMin: "1",
      perDayQtyMax: "10",
      perDayRateMin: "10",
      perDayRateMax: "50",
      occurrencePercentage,
      category,
    };
  }

  it("leaves a repair diagnostic breadcrumb on the returned invoices (proves repair was actually called, not skipped)", () => {
    const products = [
      product("A", "Meat", 40),
      product("B", "Meat", 30),
      product("C", "Meat", 30),
    ];
    const batch = {
      id: "batch-sales-wiring",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_type: "SALES",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-01-10",
      minimum_invoice_amount: 50,
      maximum_invoice_amount: 100000,
      total_amount: 5000,
      products,
      selected_customers: ["cust-1", "cust-2", "cust-3"],
      major_customers: [],
      category_allocation: null,
      occurrence_semantics: "GLOBAL",
    } as any;
    const productConfigById = new Map(products.map((p) => [p.product_id, p]));

    // A minimal but real occurrenceLedger — enough to make repair actually
    // attempt something, mirroring what real generation seeds it with
    // (see the "product-slot calibration" seeding block).
    const occurrenceLedger = new Map<string, number>([
      ["A", 4],
      ["B", 3],
      ["C", 3],
    ]);

    const Engine = InvoiceEngine as any;
    const invoices = Engine.generateInvoiceSplitupsInternal(
      batch,
      10,
      new Date("2026-01-01"),
      1,
      null,
      occurrenceLedger,
      undefined,
    );

    expect(Array.isArray(invoices)).toBe(true);
    expect(invoices.length).toBeGreaterThan(0);

    const diagnostic = (invoices as any).__occurrenceRepairDiagnostic;
    expect(
      diagnostic,
      "repairOccurrenceDeviations left no diagnostic at all — it was never called for this Sales generation",
    ).toBeDefined();
    // Whatever the outcome, it must not be the "no ledger" no-op — a real
    // ledger was provided, so any reachable early-return other than that
    // one is fine (converged, stalled, or ran out of passes all count as
    // proof the call actually happened).
    expect(diagnostic).not.toMatch(/no occurrence ledger/);
  });
});
