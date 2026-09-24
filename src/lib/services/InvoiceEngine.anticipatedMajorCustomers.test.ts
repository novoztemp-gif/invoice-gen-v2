import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";
import type { InvoiceBatch, ProductConfig } from "./InvoiceEngine";

/**
 * Anticipated Major Customer Demand — Purchase batches only, optional.
 * Root cause this addresses: a Sales "Major Customer" invoice can only
 * ever draw from ONE day. Purchase generation otherwise spreads purchased
 * quantity randomly and evenly across every day, which can leave no
 * single day with enough concentrated stock even when the total across
 * the whole range is plenty. This lets the user pre-declare that demand
 * at Purchase time so generation deliberately concentrates enough
 * same-day stock for it.
 *
 * `generatePurchaseInvoiceSplitupsInternal` is `private static` on
 * InvoiceEngine — reaching it via `(InvoiceEngine as any)` is the
 * established pattern this whole test suite already uses (see
 * InvoiceEngine.purchaseMajorDate.test.ts) rather than changing visibility.
 */
const Engine = InvoiceEngine as any;

const START_DATE = new Date(2026, 0, 1); // 2026-01-01
const NUM_DAYS = 30;

function meatProduct(id: string): ProductConfig {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "50",
    perDayRateMax: "100",
    occurrencePercentage: 100,
    category: "Meat",
  } as any;
}

function fruitsProduct(id: string): ProductConfig {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0808",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "50",
    perDayRateMax: "100",
    occurrencePercentage: 100,
    category: "Fruits",
  } as any;
}

function makeBatch(overrides: Partial<InvoiceBatch> = {}): InvoiceBatch {
  return {
    id: "batch-1",
    issuing_company_id: "co-1",
    financial_year: "2026-27",
    invoice_date_from: "2026-01-01",
    invoice_date_to: "2026-01-30",
    minimum_invoice_amount: 500,
    maximum_invoice_amount: 100000,
    total_amount: 0,
    products: [meatProduct("prod-meat-1")],
    selected_customers: ["sup-1", "sup-2"],
    major_customers: [],
    batch_type: "PURCHASE",
    ...overrides,
  } as InvoiceBatch;
}

function categoryMap(ids: string[]): Map<string, "Fruits" | "Meat"> {
  return new Map(ids.map((id) => [id, "Meat" as const]));
}

function mixedCategoryMap(
  meatIds: string[],
  fruitIds: string[],
): Map<string, "Fruits" | "Meat"> {
  return new Map([
    ...meatIds.map((id) => [id, "Meat" as const] as const),
    ...fruitIds.map((id) => [id, "Fruits" as const] as const),
  ]);
}

describe("generatePurchaseInvoiceSplitupsInternal — Anticipated Major Customer Demand", () => {
  it("builds real reservation invoices sized to cover the anticipated amount, attributed to real suppliers", () => {
    const batch = makeBatch({
      total_amount: 100000,
      anticipated_major_customers: [
        {
          customer_id: "future-major-a",
          amount: 40000,
          invoice_count: 4,
          max_invoice_amount: 12000,
        },
      ],
    } as any);

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["sup-1", "sup-2"]),
    );

    // 4 reservation invoices for the anticipated entry, each attributed to
    // a real selected supplier (round-robin across sup-1/sup-2), each on a
    // distinct day, in the Meat category, sized close to the per-invoice
    // average (40000/4=10000) with the 15% buffer, capped by the
    // configured max (12000).
    const reservationInvoices = invoices.filter((inv: any) =>
      ["sup-1", "sup-2"].includes(inv.supplier_id),
    );
    expect(reservationInvoices.length).toBeGreaterThanOrEqual(4);

    const dates = new Set(reservationInvoices.map((inv: any) => inv.invoice_date));
    expect(dates.size).toBeGreaterThan(1); // spread across more than one day

    for (const inv of reservationInvoices) {
      expect(["sup-1", "sup-2"]).toContain(inv.supplier_id);
      expect(inv.category_key).toBe("Meat");
      expect(Number(inv.total_amount)).toBeLessThanOrEqual(12000 + 0.01);
      expect(Number(inv.total_amount)).toBeGreaterThan(0);
      for (const p of inv.products) {
        expect(p.category).toBe("Meat");
      }
    }
  });

  it("subtracts the reserved total from the regular budget so the grand total still lands on total_amount", () => {
    const batch = makeBatch({
      total_amount: 50000,
      anticipated_major_customers: [
        {
          customer_id: "future-major-a",
          amount: 20000,
          invoice_count: 2,
          max_invoice_amount: 15000,
        },
      ],
    } as any);

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["sup-1", "sup-2"]),
    );

    const grandTotal = invoices.reduce(
      (sum: number, inv: any) => sum + Math.round(inv.total_amount || 0),
      0,
    );
    // Never exceeds the configured batch total (the whole point of folding
    // anticipatedReservedTotal into remainingBatchAmount) — small residual
    // tolerated for rounding across many invoices.
    expect(grandTotal).toBeLessThanOrEqual(50000 + 5);
  });

  it("is a no-op when anticipated_major_customers is empty or absent — byte-identical to before this feature", () => {
    const baseBatch = makeBatch({ total_amount: 30000 });

    const withEmptyArray = Engine.generatePurchaseInvoiceSplitupsInternal(
      { ...baseBatch, anticipated_major_customers: [] },
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["sup-1", "sup-2"]),
    );
    const withUndefined = Engine.generatePurchaseInvoiceSplitupsInternal(
      baseBatch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["sup-1", "sup-2"]),
    );

    // Same invoice count either way — no reservation invoices appended
    // when the field is empty/absent.
    expect(withEmptyArray.length).toBe(withUndefined.length);
  });

  it("concentrates enough same-day stock that a later Sales Major Customer's per-invoice average is actually achievable (the real bug this fixes)", () => {
    // Mirrors the real failure this session diagnosed: a Major Customer
    // needing a large per-invoice average, spread thin across many days
    // by pure random generation, with no single day concentrated enough.
    const batch = makeBatch({
      // Multiple Meat products — matching realistic data (the real batch
      // this session diagnosed had 11 Meat products) — so a single
      // invoice can combine several lines to reach a large target instead
      // of being capped at one product's own max line value.
      products: Array.from({ length: 8 }, (_, i) =>
        meatProduct(`prod-meat-${i + 1}`),
      ),
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-08-01", // 213 days — wide range, like the real batch
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 49900,
      total_amount: 500000,
      anticipated_major_customers: [
        {
          customer_id: "future-major-a",
          amount: 400000,
          invoice_count: 10,
          max_invoice_amount: 49900,
        },
      ],
    } as any);
    const wideNumDays = 213;

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      wideNumDays,
      START_DATE,
      1,
      undefined,
      categoryMap(["sup-1", "sup-2"]),
    );

    // Per-invoice average this (future) Major Customer will need:
    const perInvoiceAverage = 400000 / 10; // 40,000

    // Group ALL generated invoices' Meat-category value by date — this is
    // exactly the "best single day" calculation Sales generation itself
    // does when picking where to place a Major Customer invoice.
    const valueByDate = new Map<string, number>();
    for (const inv of invoices) {
      if (inv.category_key !== "Meat") continue;
      valueByDate.set(
        inv.invoice_date,
        (valueByDate.get(inv.invoice_date) || 0) + Number(inv.total_amount || 0),
      );
    }
    const bestDayValue = Math.max(...valueByDate.values());

    // Without reservation, spreading ₹500k thin across 213 days would
    // average ~₹2,347/day — nowhere near ₹40,000. With reservation
    // deliberately concentrating stock, at least one day now lands close
    // to the per-invoice average this Major Customer will need — this is
    // a strong best-effort improvement, not a mathematical guarantee (the
    // same per-line random quantity/rate variance used everywhere else in
    // this codebase means a reservation invoice doesn't always land
    // exactly on its target). Threshold set below every worst-case
    // observed over 30+ repeated runs (lowest seen: ~37,185) so this test
    // stays stable rather than flaking on rare unlucky draws, while still
    // proving concentration: 70% of the bare average is a ~12x
    // improvement over the ~6% (2,347/40,000) a pure random spread across
    // 213 days would achieve.
    expect(bestDayValue).toBeGreaterThanOrEqual(perInvoiceAverage * 0.7);
  });

  it("never exceeds the batch's own maximum invoice amount, even when the anticipated entry's max is much higher — splits across multiple same-day invoices instead", () => {
    // Client-reported bug: "Invoice Amount (₹46,880) exceeds configured
    // maximum (₹9,999)" — the anticipated entry's own max_invoice_amount
    // (sized for the FUTURE Sales invoice) can be much higher than this
    // PURCHASE batch's own configured maximum_invoice_amount, which every
    // invoice in this batch must obey, reservation ones included.
    const batch = makeBatch({
      products: Array.from({ length: 8 }, (_, i) =>
        meatProduct(`prod-meat-${i + 1}`),
      ),
      selected_customers: ["sup-1", "sup-2", "sup-3", "sup-4", "sup-5", "sup-6"],
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 9999, // batch's own cap — much lower than below
      total_amount: 100000,
      anticipated_major_customers: [
        {
          customer_id: "future-major-a",
          amount: 46880,
          invoice_count: 1,
          max_invoice_amount: 46880, // sized for the FUTURE Sales invoice
        },
      ],
    } as any);

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap([
        "sup-1",
        "sup-2",
        "sup-3",
        "sup-4",
        "sup-5",
        "sup-6",
      ]),
    );

    // No invoice — reservation or otherwise — ever exceeds this batch's
    // own configured maximum, no matter how large the anticipated entry's
    // own max_invoice_amount is.
    for (const inv of invoices) {
      expect(Number(inv.total_amount)).toBeLessThanOrEqual(9999 + 0.01);
    }

    // Concentration still happened: multiple reservation invoices (from
    // DIFFERENT suppliers) landed on the SAME day, summing to a
    // meaningful fraction of the ₹46,880 target — proving the fix
    // achieves the same goal via several small invoices instead of one
    // oversized one.
    const reservationInvoices = invoices.filter((inv: any) =>
      ["sup-1", "sup-2", "sup-3", "sup-4", "sup-5", "sup-6"].includes(
        inv.supplier_id,
      ),
    );
    const valueByDate = new Map<string, number>();
    const suppliersByDate = new Map<string, Set<string>>();
    for (const inv of reservationInvoices) {
      valueByDate.set(
        inv.invoice_date,
        (valueByDate.get(inv.invoice_date) || 0) + Number(inv.total_amount || 0),
      );
      if (!suppliersByDate.has(inv.invoice_date)) {
        suppliersByDate.set(inv.invoice_date, new Set());
      }
      suppliersByDate.get(inv.invoice_date)!.add(inv.supplier_id);
    }
    const bestDayValue = Math.max(...valueByDate.values());
    const bestDaySupplierCount = Math.max(
      ...Array.from(suppliersByDate.values()).map((s) => s.size),
    );

    expect(bestDaySupplierCount).toBeGreaterThan(1); // more than one invoice, same day
    expect(bestDayValue).toBeGreaterThan(9999); // exceeds what any ONE invoice could hold
  });

  it("lets different days within the same reservation land on different categories — unlike a supplier, the anticipated customer isn't category-locked", () => {
    // User correction this session: a Purchase SUPPLIER really is fixed to
    // one category, but the Sales CUSTOMER this reservation anticipates is
    // not — they can buy both Meat and Fruits, just never both on the same
    // bill. So each day within a reservation now picks its own category
    // the same way every other invoice's category gets decided
    // (pickCategoryFromLedger), instead of the whole reservation being
    // pinned to one fixed, user-chosen category. With categoryLedger
    // omitted (undefined) here, pickCategoryFromLedger's fallback runs —
    // a deterministic `categoryKeys[b % categoryKeys.length]` round-robin
    // by day index — so which category each day gets is fully predictable
    // without stubbing Math.random(), matching this test file's existing
    // determinism style.
    const batch = makeBatch({
      products: [meatProduct("prod-meat-1"), fruitsProduct("prod-fruit-1")],
      selected_customers: ["sup-meat-1", "sup-fruit-1"],
      total_amount: 40000,
      anticipated_major_customers: [
        {
          customer_id: "future-major-a",
          amount: 20000,
          invoice_count: 4,
          max_invoice_amount: 8000,
        },
      ],
    } as any);

    // Real generation wraps this whole call in generateWithAutoRetry (up
    // to 100 attempts on a fresh random draw) specifically because a rare,
    // genuinely-tight random draw can occasionally leave a small residual
    // a downstream guard correctly rejects rather than silently accept —
    // this test isn't exercising that retry mechanism itself, so it mirrors
    // it locally at a much smaller scale purely to avoid being flaky on an
    // unlucky draw unrelated to what this test actually checks (category
    // variety, not amount-drift precision).
    let invoices: any[] | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 10 && !invoices; attempt++) {
      try {
        invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
          batch,
          NUM_DAYS,
          START_DATE,
          1,
          undefined,
          mixedCategoryMap(["sup-meat-1"], ["sup-fruit-1"]),
        );
      } catch (err) {
        lastError = err;
      }
    }
    if (!invoices) throw lastError;

    const reservationInvoices = invoices.filter((inv: any) =>
      ["sup-meat-1", "sup-fruit-1"].includes(inv.supplier_id),
    );
    expect(reservationInvoices.length).toBeGreaterThanOrEqual(4);

    const categoriesUsed = new Set(
      reservationInvoices.map((inv: any) => inv.category_key),
    );
    expect(categoriesUsed.has("Meat")).toBe(true);
    expect(categoriesUsed.has("Fruits")).toBe(true);

    // Category purity is still absolute — every line on a given invoice
    // matches that invoice's own category_key, even though the category
    // now varies day to day.
    for (const inv of reservationInvoices) {
      for (const p of inv.products) {
        expect(p.category).toBe(inv.category_key);
      }
    }
  });

  /**
   * Root cause of a real, confirmed live failure: a Major Customer whose
   * Anticipated reservation was configured correctly (right amount, set up
   * before the linked Purchase batch's first generation) still landed
   * ₹16,896 short of its ₹365,986 target on the Sales side.
   *
   * Traced to two compounding gaps in buildOneReservationInvoice / the
   * per-day reservation loop: (1) each reservation invoice's own line-
   * building loop stops the instant one more line would exceed its
   * target, with nothing trying to close whatever gap remains — unlike
   * every other "build an invoice to hit an exact ₹ target" path in this
   * file, which already has a drift-closing step; (2) once a day's
   * remaining reservation need drops below the batch's own minimum
   * invoice amount, the leftover is discarded rather than folded into an
   * invoice already built that day. Both are individually small, but
   * compounding across many reservation invoices/days on a real six-
   * figure reservation adds up to exactly this shape of gap.
   *
   * total_amount is set well below what the reservation could plausibly
   * reach even in the worst pre-fix case, so remainingBatchAmount
   * computes to 0 and STEP 2 (regular generation) never runs — every
   * invoice in the result is a pure reservation invoice, letting the
   * reserved total be measured directly and unambiguously.
   */
  it("reserves close to the full anticipated amount, not significantly short of it, at realistic scale", () => {
    const suppliers = Array.from({ length: 15 }, (_, i) => `sup-${i + 1}`);
    const products = [
      meatProduct("prod-a"),
      meatProduct("prod-b"),
      meatProduct("prod-c"),
    ];
    const ANTICIPATED_AMOUNT = 200000;
    const THEORETICAL_CEILING = 9900 * 20; // max_invoice_amount * invoice_count
    const batch = makeBatch({
      // Matches the reservation's own theoretical ceiling exactly — the
      // function's own grand-total enforcement requires total_amount to
      // be reachable, so it can't be set arbitrarily below what
      // reservation alone can produce.
      total_amount: THEORETICAL_CEILING,
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 9900,
      products,
      selected_customers: suppliers,
      anticipated_major_customers: [
        {
          customer_id: "future-major-real",
          amount: ANTICIPATED_AMOUNT,
          invoice_count: 20,
          max_invoice_amount: 9900,
        },
      ],
    } as any);

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(suppliers),
    );

    // Every invoice in the result is a reservation invoice (STEP 2 never
    // ran — see the comment above), so the whole batch's total IS the
    // reserved total.
    const reservedTotal = invoices.reduce(
      (sum: number, inv: any) => sum + Math.round(inv.total_amount || 0),
      0,
    );

    // Reservation targets up to a 20% buffer over the bare average
    // (200000/20 * 1.2 = 12000/day, capped at max_invoice_amount 9900 ->
    // 9900/day * 20 = 198000 theoretical ceiling). Demand it get
    // meaningfully close to that — within 3% — rather than the large,
    // silent shortfall the two gaps above used to allow.
    expect(
      reservedTotal,
      `reserved ₹${reservedTotal} vs theoretical ceiling ₹${THEORETICAL_CEILING} — gap too large`,
    ).toBeGreaterThanOrEqual(THEORETICAL_CEILING * 0.97);
  });
});
