import { describe, expect, it } from "vitest";
import { PurchaseInvoiceValidator } from "./PurchaseInvoiceValidator";
import { PurchaseInvoice } from "./types";

/**
 * Real bug hit during live testing: a small number of pre-existing
 * invoices (e.g. financial year 2021-22) have a stored total_amount that
 * doesn't match the sum of their own lines, even though every individual
 * line is itself exactly correct (amount === quantity x rate). Since
 * FinalValidator revalidates the WHOLE batch on every single edit, this
 * permanently blocked editing ANY invoice in a batch containing one of
 * these — not just the broken invoice itself.
 *
 * selfHealHeaderTotals is called from loadContext, before anything else
 * runs, and corrects exactly this narrow case: an invoice's own header
 * total is unambiguously wrong (its lines already agree with each other
 * and with commercial arithmetic), so there's nothing to guess — it gets
 * recomputed from its own lines. `PurchaseInvoiceValidator`'s constructor
 * only needs a SupabaseClient for its OTHER (DB-calling) methods —
 * selfHealHeaderTotals is pure data transformation, so `null` is a safe
 * stand-in here.
 */
const validator = new PurchaseInvoiceValidator(null as any);
const selfHeal = (invoices: PurchaseInvoice[]) =>
  (validator as any).selfHealHeaderTotals(invoices) as Map<
    string,
    PurchaseInvoice
  >;

function invoice(overrides: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  return {
    id: "inv-1",
    invoice_batch_id: "batch-1",
    invoice_number: "AT-2021-22-P-0000001",
    invoice_date: "2021-06-01",
    products: [],
    total_amount: 0,
    ...overrides,
  };
}

describe("PurchaseInvoiceValidator.selfHealHeaderTotals", () => {
  it("corrects a stored total that doesn't match its own (individually exact) lines — the real reported case", () => {
    // AT-2021-22-P-0003296: stored 6254, lines actually sum to 7200.
    const inv = invoice({
      id: "real-1",
      invoice_number: "AT-2021-22-P-0003296",
      total_amount: 6254,
      products: [
        {
          product_id: "3becd33e-88e3-4854-95cb-5bf68ab4665f",
          quantity: 10,
          rate: 420,
          amount: 4200,
        },
        {
          product_id: "97d0f62a-0791-438d-93a8-d77258ac97d2",
          quantity: 10,
          rate: 300,
          amount: 3000,
        },
      ],
    });

    const corrections = selfHeal([inv]);

    expect(inv.total_amount).toBe(7200);
    expect(corrections.get("real-1")?.total_amount).toBe(7200);
  });

  it("corrects a small ₹1 header drift the same way as a large one", () => {
    // AT-2021-22-P-0003113: stored 8438, lines actually sum to 8437.
    const inv = invoice({
      id: "real-2",
      total_amount: 8438,
      products: [
        { product_id: "p1", quantity: 11.25, rate: 353, amount: 3971 },
        { product_id: "p2", quantity: 11.25, rate: 397, amount: 4466 },
      ],
    });

    const corrections = selfHeal([inv]);

    expect(inv.total_amount).toBe(8437);
    expect(corrections.has("real-2")).toBe(true);
  });

  it("leaves an already-consistent invoice completely untouched", () => {
    const inv = invoice({
      id: "clean-1",
      total_amount: 5000,
      products: [{ product_id: "p1", quantity: 10, rate: 500, amount: 5000 }],
    });

    const corrections = selfHeal([inv]);

    expect(inv.total_amount).toBe(5000);
    expect(corrections.size).toBe(0);
  });

  it("never touches an invoice where a LINE itself is wrong — genuinely ambiguous, left for real validation to catch", () => {
    // Line amount (999) doesn't match quantity x rate (10 x 100 = 1000) —
    // this is a different, ambiguous kind of corruption (is the amount
    // wrong, or the quantity, or the rate?) that must not be silently
    // "fixed" by guessing.
    const inv = invoice({
      id: "ambiguous-1",
      total_amount: 999,
      products: [{ product_id: "p1", quantity: 10, rate: 100, amount: 999 }],
    });

    const corrections = selfHeal([inv]);

    expect(inv.total_amount).toBe(999);
    expect(corrections.size).toBe(0);
  });

  it("only reports invoices that actually needed correction, across a mixed batch", () => {
    const clean = invoice({
      id: "clean-2",
      total_amount: 1000,
      products: [{ product_id: "p1", quantity: 10, rate: 100, amount: 1000 }],
    });
    const broken = invoice({
      id: "broken-1",
      total_amount: 500,
      products: [{ product_id: "p1", quantity: 10, rate: 100, amount: 1000 }],
    });

    const corrections = selfHeal([clean, broken]);

    expect(corrections.size).toBe(1);
    expect(corrections.has("clean-2")).toBe(false);
    expect(broken.total_amount).toBe(1000);
  });
});
