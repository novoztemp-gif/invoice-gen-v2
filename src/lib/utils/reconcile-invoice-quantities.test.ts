import { describe, expect, it } from "vitest";
import {
  reconcileInvoicesToTargets,
  repairInvoiceAmountRange,
} from "./reconcile-invoice-quantities";

/**
 * Client-reported bug — reconciled Sales invoices landing outside the
 * configured [minimum, maximum] invoice amount range (e.g. a batch
 * configured for 7,000-49,800 producing an invoice at 49,950).
 *
 * Root cause: when an increase couldn't fit within maximumInvoiceAmount
 * on any existing same-date invoice, reconcileInvoicesToTargets preferred
 * growing an EXISTING invoice that already carried the product PAST its
 * configured maximum over opening a new, safe invoice for the overflow —
 * purely because a matching invoice happened to exist. Opening a new
 * invoice was only ever tried as a fallback when no matching invoice
 * existed at all.
 *
 * Fix: opening new invoice(s) for the overflow is now tried FIRST
 * whenever a fallback customer is available — splitting across more than
 * one new invoice if a single one would itself exceed the maximum, and
 * only falling back to growing an existing invoice past its limit as an
 * absolute last resort (no fallback customer, or the overflow is too
 * small to form a valid invoice on its own — checked against
 * minimumInvoiceAmount, a new parameter, so this fix doesn't just trade a
 * maximum-side violation for a minimum-side one).
 */

function product(id: string, category: "Meat" | "Fruits" = "Meat") {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayRateMin: "100",
    perDayRateMax: "100",
    category,
  };
}

describe("reconcileInvoicesToTargets — maximum invoice amount is never exceeded", () => {
  it("opens a new invoice for overflow instead of pushing an existing invoice past the maximum", () => {
    const invoices = [
      {
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 49000,
        products: [
          {
            product_id: "P1",
            product_name: "P1",
            hsn_code: "0207",
            unit_of_measure: "kg",
            category: "Meat",
            quantity: 490,
            rate: 100,
            amount: 49000,
            customer_id: "cust-1",
          },
        ],
      },
    ];

    // Target requires 100 MORE units of P1 on 2026-08-02 than currently
    // present (490 -> 590) — at rate 100, that's +10,000, which would
    // push the only existing same-date invoice to 59,000, well past a
    // 49,800 maximum. No other same-date invoice exists to absorb it.
    const targetQtyMap = new Map<string, number>([["2026-08-02_P1", 590]]);

    const result = reconcileInvoicesToTargets(
      invoices,
      targetQtyMap,
      [product("P1")],
      "fallback-cust",
      49800, // maximumInvoiceAmount
      new Set(), // no major customers
      7000, // minimumInvoiceAmount
    );

    // No invoice — old or newly-opened — ever exceeds the configured
    // maximum. The existing invoice legitimately absorbs whatever
    // headroom it has (up to 49,800) before any overflow opens a new
    // invoice, so it lands AT the cap, not above it.
    for (const inv of result) {
      expect(Number(inv.total_amount)).toBeLessThanOrEqual(49800 + 0.01);
    }
    expect(result.length).toBeGreaterThan(1);

    // Total P1 quantity across every invoice matches the target exactly —
    // the overflow wasn't dropped, just relocated to new invoice(s).
    const totalQty = result.reduce(
      (sum: number, inv: any) =>
        sum +
        (inv.products || [])
          .filter((p: any) => p.product_id === "P1")
          .reduce((s: number, p: any) => s + Number(p.quantity || 0), 0),
      0,
    );
    expect(totalQty).toBeCloseTo(590, 2);
  });

  it("does not open an undersized new invoice below the minimum — falls back to the existing invoice for a genuinely tiny overflow", () => {
    const invoices = [
      {
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 49000,
        products: [
          {
            product_id: "P1",
            product_name: "P1",
            hsn_code: "0207",
            unit_of_measure: "kg",
            category: "Meat",
            quantity: 490,
            rate: 100,
            amount: 49000,
            customer_id: "cust-1",
          },
        ],
      },
    ];

    // Only +1 unit (₹100) of overflow — far below a 7,000 minimum, so a
    // standalone new invoice for it would itself violate the minimum.
    const targetQtyMap = new Map<string, number>([["2026-08-02_P1", 491]]);

    const result = reconcileInvoicesToTargets(
      invoices,
      targetQtyMap,
      [product("P1")],
      "fallback-cust",
      49800,
      new Set(),
      7000,
    );

    // No new invoice was created for such a tiny overflow.
    expect(result.length).toBe(1);
    expect(result[0].total_amount).toBe(49100);
  });
});

/**
 * Client-reported bug — after choosing "Null" (sell 100% of available
 * stock, zero leftover) in the Daily Stock Review modal, a real batch
 * still ended up with ~38 KG of unsold "Leftover Stock" reappearing
 * afterward. Root cause: when a single product's own leftover couldn't
 * fit any existing invoice's headroom AND was too small on its own to
 * justify a new invoice (below minimumInvoiceAmount), it was silently
 * dropped — logged via console.warn only, batch still saved, that stock
 * never marked sold.
 *
 * Fix: instead of dropping it, such residuals are pooled across every
 * OTHER product sharing the same date+category before giving up — a
 * leftover too small alone routinely clears the minimum once combined
 * with what other products also couldn't place.
 */
describe("reconcileInvoicesToTargets — Null mode never silently drops unplaceable leftover", () => {
  it("pools two products' individually-too-small overflow on the same date+category into one new invoice", () => {
    const invoices = [
      {
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 49800,
        products: [
          {
            product_id: "P1",
            product_name: "P1",
            hsn_code: "0207",
            unit_of_measure: "kg",
            category: "Meat",
            quantity: 498,
            rate: 100,
            amount: 49800,
            customer_id: "cust-1",
          },
        ],
      },
      {
        invoice_date: "2026-08-02",
        customer_id: "cust-2",
        total_amount: 49800,
        products: [
          {
            product_id: "P2",
            product_name: "P2",
            hsn_code: "0207",
            unit_of_measure: "kg",
            category: "Meat",
            quantity: 498,
            rate: 100,
            amount: 49800,
            customer_id: "cust-2",
          },
        ],
      },
    ];

    // Both existing invoices are already AT the maximum (zero headroom).
    // P1 needs +30 (₹3,000) and P2 needs +50 (₹5,000) — each alone is
    // below the 7,000 minimum, so neither could open its own invoice.
    // Pooled together on the same date+category: ₹8,000 — comfortably
    // clears the minimum.
    const targetQtyMap = new Map<string, number>([
      ["2026-08-02_P1", 528],
      ["2026-08-02_P2", 548],
    ]);

    const result = reconcileInvoicesToTargets(
      invoices,
      targetQtyMap,
      [product("P1"), product("P2")],
      "fallback-cust",
      49800,
      new Set(),
      7000,
    );

    // A new invoice was opened carrying BOTH products' pooled overflow —
    // not silently dropped, and not forced above the maximum either.
    expect(result.length).toBe(3);
    const newInv = result.find(
      (inv: any) => inv.total_amount !== 49800,
    );
    expect(newInv).toBeTruthy();
    expect(Number(newInv.total_amount)).toBeGreaterThanOrEqual(7000);
    expect(Number(newInv.total_amount)).toBeLessThanOrEqual(49800 + 0.01);
    expect(newInv.products.length).toBe(2);

    // Every last unit made it onto SOME invoice — nothing left unsold.
    const totalP1 = result.reduce(
      (sum: number, inv: any) =>
        sum +
        (inv.products || [])
          .filter((p: any) => p.product_id === "P1")
          .reduce((s: number, p: any) => s + Number(p.quantity || 0), 0),
      0,
    );
    const totalP2 = result.reduce(
      (sum: number, inv: any) =>
        sum +
        (inv.products || [])
          .filter((p: any) => p.product_id === "P2")
          .reduce((s: number, p: any) => s + Number(p.quantity || 0), 0),
      0,
    );
    expect(totalP1).toBeCloseTo(528, 2);
    expect(totalP2).toBeCloseTo(548, 2);
  });

  it("falls back to forcing a genuinely tiny pooled residual onto an existing invoice rather than dropping it", () => {
    const invoices = [
      {
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 49800,
        products: [
          {
            product_id: "P1",
            product_name: "P1",
            hsn_code: "0207",
            unit_of_measure: "kg",
            category: "Meat",
            quantity: 498,
            rate: 100,
            amount: 49800,
            customer_id: "cust-1",
          },
        ],
      },
    ];

    // +1 unit (₹100) — even pooled with itself (only one product involved,
    // nothing else to combine with), far below the 7,000 minimum. No
    // fallback customer this time, so opening a new invoice isn't an
    // option at all — must land on the existing invoice, not vanish.
    const targetQtyMap = new Map<string, number>([["2026-08-02_P1", 499]]);

    const result = reconcileInvoicesToTargets(
      invoices,
      targetQtyMap,
      [product("P1")],
      null, // no fallback customer available
      49800,
      new Set(),
      7000,
    );

    expect(result.length).toBe(1);
    // The single unit was placed (total went up), not dropped.
    expect(Number(result[0].total_amount)).toBe(49900);
  });
});

/**
 * Client-reported bug — a batch could be successfully CREATED with regular
 * invoices outside the configured [minimum, maximum] range (confirmed on a
 * real batch: invoices at ₹5,181 against a ₹7,000–49,800 range), only to
 * fail later at Finalize with no way to fix it except deleting the whole
 * batch and starting over. The user explicitly asked for self-correction
 * instead of an error: "the system should rectify the invoices and
 * allocate itself" rather than reject up front.
 *
 * repairInvoiceAmountRange is the fix — actually brings invoices back
 * into range instead of just detecting the problem.
 */
function productWithBounds(id: string, category: "Meat" | "Fruits" = "Meat") {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayRateMin: "100",
    perDayRateMax: "100",
    perDayQtyMax: "500",
    category,
  };
}

describe("repairInvoiceAmountRange", () => {
  it("sheds excess from an over-maximum invoice onto a same-date/category peer with headroom", () => {
    const invoices = [
      {
        invoice_number: "INV-1",
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 57940,
        products: [
          {
            product_id: "P1",
            category: "Meat",
            quantity: 579.4,
            rate: 100,
            amount: 57940,
            customer_id: "cust-1",
          },
        ],
      },
      {
        invoice_number: "INV-2",
        invoice_date: "2026-08-02",
        customer_id: "cust-2",
        total_amount: 20000,
        products: [
          {
            product_id: "P2",
            category: "Meat",
            quantity: 200,
            rate: 100,
            amount: 20000,
            customer_id: "cust-2",
          },
        ],
      },
    ];

    const result = repairInvoiceAmountRange(
      invoices,
      7000,
      49800,
      [productWithBounds("P1"), productWithBounds("P2")],
      new Map(),
      "fallback-cust",
      new Set(),
    );

    expect(result.stillViolating.length).toBe(0);
    for (const inv of result.invoices) {
      expect(Number(inv.total_amount)).toBeLessThanOrEqual(49800 + 0.01);
      expect(Number(inv.total_amount)).toBeGreaterThanOrEqual(7000 - 0.01);
    }
    // No quantity destroyed — conserved across whichever invoice(s) it
    // ends up on.
    const totalQty = result.invoices.reduce(
      (sum, inv) =>
        sum +
        (inv.products || []).reduce(
          (s: number, p: any) => s + Number(p.quantity || 0),
          0,
        ),
      0,
    );
    expect(totalQty).toBeCloseTo(779.4, 2);
  });

  it("merges a below-minimum invoice into a same-date/category peer with room", () => {
    const invoices = [
      {
        invoice_number: "INV-1",
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 4975,
        products: [
          {
            product_id: "P1",
            category: "Meat",
            quantity: 49.75,
            rate: 100,
            amount: 4975,
            customer_id: "cust-1",
          },
        ],
      },
      {
        invoice_number: "INV-2",
        invoice_date: "2026-08-02",
        customer_id: "cust-2",
        total_amount: 20000,
        products: [
          {
            product_id: "P2",
            category: "Meat",
            quantity: 200,
            rate: 100,
            amount: 20000,
            customer_id: "cust-2",
          },
        ],
      },
    ];

    const result = repairInvoiceAmountRange(
      invoices,
      7000,
      49800,
      [productWithBounds("P1"), productWithBounds("P2")],
      new Map(),
      "fallback-cust",
      new Set(),
    );

    expect(result.stillViolating.length).toBe(0);
    expect(result.invoices.length).toBe(1);
    expect(result.invoices[0].total_amount).toBe(24975);
  });

  it("grows a below-minimum invoice using real remaining stock when no peer exists", () => {
    const invoices = [
      {
        invoice_number: "INV-1",
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 5000,
        products: [
          {
            product_id: "P1",
            category: "Meat",
            quantity: 50,
            rate: 100,
            amount: 5000,
            customer_id: "cust-1",
          },
        ],
      },
    ];
    // Plenty of real remaining stock for P1 on this date.
    const remainingStock = new Map([["2026-08-02_P1", 200]]);

    const result = repairInvoiceAmountRange(
      invoices,
      7000,
      49800,
      [productWithBounds("P1")],
      remainingStock,
      "fallback-cust",
      new Set(),
    );

    expect(result.stillViolating.length).toBe(0);
    expect(result.invoices.length).toBe(1);
    expect(Number(result.invoices[0].total_amount)).toBeGreaterThanOrEqual(7000);
  });

  it("closes the shortfall via a last-resort price push (past the configured rateMax) when real stock is genuinely exhausted and no peer exists", () => {
    const invoices = [
      {
        invoice_number: "INV-1",
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 5000,
        products: [
          {
            product_id: "P1",
            product_name: "P1",
            category: "Meat",
            quantity: 50,
            rate: 100,
            amount: 5000,
            customer_id: "cust-1",
          },
        ],
      },
    ];
    // No real remaining stock at all, and productWithBounds fixes
    // perDayRateMin === perDayRateMax === 100 (already the current rate)
    // — zero room anywhere within the configured range either. The only
    // lever left is the confirmed last resort: push price past the
    // configured maximum by exactly enough to clear the minimum.
    const remainingStock = new Map([["2026-08-02_P1", 0]]);

    const result = repairInvoiceAmountRange(
      invoices,
      7000,
      49800,
      [productWithBounds("P1")],
      remainingStock,
      "fallback-cust",
      new Set(),
    );

    expect(result.stillViolating.length).toBe(0);
    const inv = result.invoices.find((i: any) => i.invoice_number === "INV-1");
    expect(inv.total_amount).toBe(7000);
    expect(inv.products[0].quantity).toBe(50); // stock/quantity never touched
    expect(inv.products[0].rate).toBeGreaterThan(100); // past the configured max
  });

  /**
   * Real, reported bug: Step 3 could only grow a below-minimum invoice by
   * adding more of a product ALREADY on that invoice — bounded by real
   * remaining stock for that one product. If that specific product was
   * stock-maxed for the date, the invoice was reported as stillViolating
   * even when a DIFFERENT product (same category, not yet on the invoice)
   * had plenty of real stock sitting right there on the same date. Fixed
   * by trying a brand-new product line (same convention as the existing
   * new-line logic elsewhere in this file: category purity enforced, rate
   * at the configured range's midpoint) before giving up.
   */
  it("adds a brand-new product line to close a shortfall when the invoice's own product is stock-maxed but a different product has real room", () => {
    const invoices = [
      {
        invoice_number: "INV-1",
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 5850,
        products: [
          {
            product_id: "P1",
            product_name: "P1",
            category: "Meat",
            quantity: 58.5,
            rate: 100,
            amount: 5850,
            customer_id: "cust-1",
          },
        ],
      },
    ];
    // P1 (already on the invoice) has NO real remaining stock — exactly
    // the reported case. P2 (same category, not yet on the invoice) has
    // plenty.
    const remainingStock = new Map([
      ["2026-08-02_P1", 0],
      ["2026-08-02_P2", 50],
    ]);

    const result = repairInvoiceAmountRange(
      invoices,
      6000,
      49800,
      [productWithBounds("P1"), productWithBounds("P2")],
      remainingStock,
      "fallback-cust",
      new Set(),
    );

    expect(result.stillViolating.length).toBe(0);
    expect(result.invoices.length).toBe(1);
    expect(Number(result.invoices[0].total_amount)).toBeGreaterThanOrEqual(
      6000 - 0.01,
    );
    const productIds = result.invoices[0].products.map(
      (p: any) => p.product_id,
    );
    expect(productIds).toContain("P1");
    expect(productIds).toContain("P2");
    // Category purity preserved on the new line.
    for (const p of result.invoices[0].products) {
      expect(p.category).toBe("Meat");
    }
  });

  it("closes via last-resort price push when NO product (existing or new, same category) has any real stock room", () => {
    const invoices = [
      {
        invoice_number: "INV-1",
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 5850,
        products: [
          {
            product_id: "P1",
            product_name: "P1",
            category: "Meat",
            quantity: 58.5,
            rate: 100,
            amount: 5850,
            customer_id: "cust-1",
          },
        ],
      },
    ];
    // P2 exists in the product catalog but has zero real stock too — no
    // stock lever anywhere. Falls through to the confirmed last resort:
    // push P1's price past its configured maximum.
    const remainingStock = new Map([
      ["2026-08-02_P1", 0],
      ["2026-08-02_P2", 0],
    ]);

    const result = repairInvoiceAmountRange(
      invoices,
      6000,
      49800,
      [productWithBounds("P1"), productWithBounds("P2")],
      remainingStock,
      "fallback-cust",
      new Set(),
    );

    expect(result.stillViolating.length).toBe(0);
    const inv = result.invoices.find((i: any) => i.invoice_number === "INV-1");
    expect(inv.total_amount).toBeGreaterThanOrEqual(6000 - 0.01);
    expect(inv.products[0].quantity).toBe(58.5); // stock/quantity never touched
    expect(inv.products[0].rate).toBeGreaterThan(100); // past the configured max
    expect(
      inv.products.some((p: any) => p.product_id === "P2"),
    ).toBe(false); // no stock existed for P2, so it's never added
  });

  it("never adds a new product line from a DIFFERENT category, even with real stock available — closes via last-resort price push on P1 instead", () => {
    const invoices = [
      {
        invoice_number: "INV-1",
        invoice_date: "2026-08-02",
        customer_id: "cust-1",
        total_amount: 5850,
        products: [
          {
            product_id: "P1",
            product_name: "P1",
            category: "Meat",
            quantity: 58.5,
            rate: 100,
            amount: 5850,
            customer_id: "cust-1",
          },
        ],
      },
    ];
    // P-Fruit has plenty of stock but is a different category — must
    // never be added onto a Meat invoice, even though it would have
    // trivially closed the gap via real stock.
    const remainingStock = new Map([
      ["2026-08-02_P1", 0],
      ["2026-08-02_P-Fruit", 50],
    ]);

    const result = repairInvoiceAmountRange(
      invoices,
      6000,
      49800,
      [productWithBounds("P1"), productWithBounds("P-Fruit", "Fruits")],
      remainingStock,
      "fallback-cust",
      new Set(),
    );

    // Category purity holds even under the last-resort price push — it
    // closes the gap via P1's own price, never by reaching for P-Fruit.
    expect(result.stillViolating.length).toBe(0);
    expect(result.invoices[0].products[0].rate).toBeGreaterThan(100);
    const productIds = result.invoices[0].products.map(
      (p: any) => p.product_id,
    );
    expect(productIds).not.toContain("P-Fruit");
  });

  it("closes a below-minimum shortfall via RATE only (toward configured rateMax) when zero real stock room exists anywhere for that date+category — a pre-made/fixed-stock batch", () => {
    const invoices = [
      {
        invoice_number: "INV-1",
        invoice_date: "2026-08-01",
        customer_id: "cust-1",
        total_amount: 2010,
        products: [
          {
            product_id: "P1",
            category: "Meat",
            quantity: 20.1,
            rate: 100,
            amount: 2010,
            customer_id: "cust-1",
          },
        ],
      },
    ];

    // Zero stock room anywhere — remainingStockByDateProduct has no entry
    // at all for this date+product, which resolves to 0 room, exactly the
    // reported real-batch scenario.
    const result = repairInvoiceAmountRange(
      invoices,
      7000,
      49800,
      [
        {
          product_id: "P1",
          product_name: "P1",
          hsn_code: "0207",
          unit_of_measure: "kg",
          perDayRateMin: "100",
          perDayRateMax: "350",
          perDayQtyMax: "500",
          category: "Meat",
        },
      ],
      new Map(),
      "fallback-cust",
      new Set(),
    );

    // 7000 / 20.1 = ~348.3 -> rate must rise to at least 349 to clear
    // minimum at the SAME quantity — well within the configured [100,350]
    // range, so this should close cleanly with quantity left untouched.
    expect(result.stillViolating.length).toBe(0);
    const inv = result.invoices.find((i: any) => i.invoice_number === "INV-1");
    expect(inv.products[0].quantity).toBeCloseTo(20.1, 2);
    expect(inv.products[0].rate).toBeLessThanOrEqual(350);
    expect(Number(inv.total_amount)).toBeGreaterThanOrEqual(7000 - 0.01);
  });

  it("as an absolute last resort, pushes rate PAST the configured rateMax to clear the minimum when stock is fixed and the minimum can't be lowered (confirmed with the user)", () => {
    const invoices = [
      {
        invoice_number: "INV-1",
        invoice_date: "2026-08-01",
        customer_id: "cust-1",
        total_amount: 100,
        products: [
          {
            product_id: "P1",
            product_name: "P1",
            category: "Meat",
            quantity: 1,
            rate: 100,
            amount: 100,
            customer_id: "cust-1",
          },
        ],
      },
    ];

    const result = repairInvoiceAmountRange(
      invoices,
      7000,
      49800,
      [
        {
          product_id: "P1",
          product_name: "P1",
          hsn_code: "0207",
          unit_of_measure: "kg",
          perDayRateMin: "100",
          perDayRateMax: "150",
          perDayQtyMax: "500",
          category: "Meat",
        },
      ],
      new Map(),
      "fallback-cust",
      new Set(),
    );

    // Zero stock room and even rateMax (150) on 1kg only reaches ₹150 —
    // nowhere near the ₹7000 minimum. Rather than give up, the last
    // resort pushes rate straight to whatever clears the minimum exactly
    // (7000 here, since quantity stays fixed at 1kg), even though that's
    // above the configured rateMax of 150.
    expect(result.stillViolating.length).toBe(0);
    const inv = result.invoices.find((i: any) => i.invoice_number === "INV-1");
    expect(inv.products[0].quantity).toBe(1);
    expect(inv.products[0].rate).toBe(7000);
    expect(inv.total_amount).toBe(7000);
  });

  it("still reports still-violating when there are genuinely no product lines to nudge at all", () => {
    const invoices = [
      {
        invoice_number: "INV-EMPTY",
        invoice_date: "2026-08-01",
        customer_id: "cust-1",
        total_amount: 0,
        products: [],
      },
    ];

    const result = repairInvoiceAmountRange(
      invoices,
      7000,
      49800,
      [],
      new Map(),
      "fallback-cust",
      new Set(),
    );

    expect(result.stillViolating.length).toBe(1);
  });

  it("never touches a Major Customer invoice, even if it's outside the batch-wide range", () => {
    const invoices = [
      {
        invoice_number: "INV-MAJOR",
        invoice_date: "2026-08-02",
        customer_id: "major-cust",
        total_amount: 345675,
        products: [
          {
            product_id: "P1",
            category: "Meat",
            quantity: 3456.75,
            rate: 100,
            amount: 345675,
            customer_id: "major-cust",
          },
        ],
      },
    ];

    const result = repairInvoiceAmountRange(
      invoices,
      7000,
      49800,
      [productWithBounds("P1")],
      new Map(),
      "fallback-cust",
      new Set(["major-cust"]),
    );

    // Untouched — no shed, no merge, no "still violating" report either,
    // since majors have their own separate amount rules checked elsewhere.
    expect(result.stillViolating.length).toBe(0);
    expect(result.invoices.length).toBe(1);
    expect(result.invoices[0].total_amount).toBe(345675);
  });
});
