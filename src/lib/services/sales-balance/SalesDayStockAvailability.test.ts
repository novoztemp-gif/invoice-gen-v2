import { describe, expect, it } from "vitest";
import {
  computeAvailableForEdit,
  computeEditableDayPool,
  loadDayAvailability,
} from "./SalesDayStockAvailability";
import type { SalesBalanceContext, SalesInvoice } from "./types";

const PRODUCT_A = "product-a";
const PRODUCT_B = "product-b";

function makeInvoice(
  id: string,
  date: string,
  lines: Array<{ product_id: string; quantity: number }>,
): SalesInvoice {
  return {
    id,
    invoice_batch_id: "batch-1",
    invoice_number: id,
    invoice_date: date,
    products: lines.map((l) => ({
      product_id: l.product_id,
      product_name: l.product_id,
      hsn_code: "1234",
      unit_of_measure: "kg",
      quantity: l.quantity,
      rate: 100,
      amount: l.quantity * 100,
    })),
    total_amount: lines.reduce((s, l) => s + l.quantity * 100, 0),
  };
}

function makeContext(invoices: SalesInvoice[]): SalesBalanceContext {
  return {
    batchId: "batch-1",
    batchTotal: 0,
    stockSourceBatchId: null,
    originalProductTotals: new Map(),
    availableStockMap: new Map(),
    totalPurchasedByProduct: new Map(),
    invoices,
    constraints: new Map(),
    majorCustomerIds: new Set(),
  };
}

/** Minimal chainable Supabase mock covering the `.from().select().in().eq().range()` shape used by loadDayAvailability. */
function makeMockSupabase(rows: any[]) {
  const chain: any = {
    from: () => chain,
    select: () => chain,
    in: () => chain,
    eq: () => chain,
    order: () => chain,
    range: (from: number, to: number) => {
      const page = rows.slice(from, to + 1);
      return Promise.resolve({ data: page, error: null });
    },
  };
  return chain;
}

describe("loadDayAvailability", () => {
  it("returns an empty map when there are no source batches or no date", async () => {
    const supabase = makeMockSupabase([]);
    expect(await loadDayAvailability(supabase as any, [], "2026-08-05")).toEqual(
      new Map(),
    );
    expect(
      await loadDayAvailability(supabase as any, ["b1"], ""),
    ).toEqual(new Map());
  });

  it("sums each product's same-date rows across multiple source batches", async () => {
    const rows = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-05",
        opening_stock: 10,
        purchased_quantity: 5,
        sold_quantity: 0,
      },
      {
        product_id: PRODUCT_B,
        ledger_date: "2026-08-05",
        opening_stock: 20,
        purchased_quantity: 0,
        sold_quantity: 0,
      },
    ];
    const supabase = makeMockSupabase(rows);
    const result = await loadDayAvailability(
      supabase as any,
      ["b1", "b2"],
      "2026-08-05",
    );
    expect(result.get(PRODUCT_A)).toBe(15);
    expect(result.get(PRODUCT_B)).toBe(20);
  });

  it("REGRESSION — nets out everything sold on PRIOR days, never trusting a later day's stale stored opening_stock column directly", async () => {
    // Real production bug: a day-cap check that read the raw opening_stock
    // column for the target date directly ignored every earlier day's
    // sales entirely, overstating what was actually left — an edit passed
    // the day-cap check here but then got rejected by the batch-wide
    // overstock ceiling downstream. StockCalculationService's own rule:
    // the stored opening_stock is only authoritative for a ledger's first
    // row; every later day's true opening is the PREVIOUS day's
    // chronologically-computed closing.
    const rows = [
      // Day 1 (the real seed): opening 10 + purchased 5 = 15 available,
      // 8 sold -> closing 7.
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-04",
        opening_stock: 10,
        purchased_quantity: 5,
        sold_quantity: 8,
      },
      // Day 2 (the target date): stored opening_stock (100) is stale/
      // irrelevant noise — the true opening is day 1's closing (7). True
      // available = 7 + 3 purchased = 10, NOT 100 + 3 = 103.
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-05",
        opening_stock: 100,
        purchased_quantity: 3,
        sold_quantity: 0,
      },
    ];
    const supabase = makeMockSupabase(rows);
    const result = await loadDayAvailability(
      supabase as any,
      ["b1"],
      "2026-08-05",
    );
    expect(result.get(PRODUCT_A)).toBe(10);
  });

  it("pages through results beyond a single page", async () => {
    const rows = Array.from({ length: 5 }, () => ({
      product_id: PRODUCT_A,
      ledger_date: "2026-08-05",
      opening_stock: 1,
      purchased_quantity: 0,
      sold_quantity: 0,
    }));
    const chain: any = {
      from: () => chain,
      select: () => chain,
      in: () => chain,
      eq: () => chain,
      order: () => chain,
      range: (from: number, to: number) => {
        const page = rows.slice(from, to + 1);
        return Promise.resolve({ data: page, error: null });
      },
    };
    const result = await loadDayAvailability(chain, ["b1"], "2026-08-05");
    expect(result.get(PRODUCT_A)).toBe(5);
  });
});

describe("computeAvailableForEdit", () => {
  it("a product with no static-availability entry resolves to zero", () => {
    const context = makeContext([]);
    const result = computeAvailableForEdit(
      context,
      new Map(),
      "2026-08-05",
      "edited-inv",
    );
    expect(result.get(PRODUCT_A) || 0).toBe(0);
  });

  it("subtracts what OTHER invoices on the same day already hold", () => {
    const other = makeInvoice("other-1", "2026-08-05", [
      { product_id: PRODUCT_A, quantity: 4 },
    ]);
    const context = makeContext([other]);
    const staticAvailable = new Map([[PRODUCT_A, 10]]);
    const result = computeAvailableForEdit(
      context,
      staticAvailable,
      "2026-08-05",
      "edited-inv",
    );
    expect(result.get(PRODUCT_A)).toBe(6);
  });

  it("excludes the edited invoice's own current holding from 'already consumed'", () => {
    const edited = makeInvoice("edited-inv", "2026-08-05", [
      { product_id: PRODUCT_A, quantity: 4 },
    ]);
    const context = makeContext([edited]);
    const staticAvailable = new Map([[PRODUCT_A, 10]]);
    const result = computeAvailableForEdit(
      context,
      staticAvailable,
      "2026-08-05",
      "edited-inv",
    );
    // The edited invoice's own 4kg isn't counted as "used by others" — all
    // 10kg reads as available for it to reclaim (including its own 4kg).
    expect(result.get(PRODUCT_A)).toBe(10);
  });

  it("ignores invoices on a different day entirely", () => {
    const otherDay = makeInvoice("other-1", "2026-08-06", [
      { product_id: PRODUCT_A, quantity: 9 },
    ]);
    const context = makeContext([otherDay]);
    const staticAvailable = new Map([[PRODUCT_A, 10]]);
    const result = computeAvailableForEdit(
      context,
      staticAvailable,
      "2026-08-05",
      "edited-inv",
    );
    expect(result.get(PRODUCT_A)).toBe(10);
  });

  it("never goes negative even if others somehow over-consumed", () => {
    const other = makeInvoice("other-1", "2026-08-05", [
      { product_id: PRODUCT_A, quantity: 15 },
    ]);
    const context = makeContext([other]);
    const staticAvailable = new Map([[PRODUCT_A, 10]]);
    const result = computeAvailableForEdit(
      context,
      staticAvailable,
      "2026-08-05",
      "edited-inv",
    );
    expect(result.get(PRODUCT_A)).toBe(0);
  });
});

describe("computeEditableDayPool", () => {
  function invoiceWithParty(
    id: string,
    date: string,
    customerId: string,
    lines: Array<{ product_id: string; quantity: number }>,
  ): SalesInvoice {
    return {
      id,
      invoice_batch_id: "batch-1",
      invoice_number: id,
      invoice_date: date,
      products: lines.map((l) => ({
        product_id: l.product_id,
        product_name: l.product_id,
        hsn_code: "1234",
        unit_of_measure: "kg",
        quantity: l.quantity,
        rate: 100,
        amount: l.quantity * 100,
        customer_id: customerId,
      })),
      total_amount: lines.reduce((s, l) => s + l.quantity * 100, 0),
    };
  }

  it("subtracts ONLY Major Customer consumption, leaving regular invoices' holdings fully in the pool", () => {
    const majorInv = invoiceWithParty("major-1", "2026-08-05", "cust-major", [
      { product_id: PRODUCT_A, quantity: 3 },
    ]);
    const regularInv = invoiceWithParty("reg-1", "2026-08-05", "cust-reg", [
      { product_id: PRODUCT_A, quantity: 5 },
    ]);
    const context: SalesBalanceContext = {
      batchId: "batch-1",
      batchTotal: 0,
      stockSourceBatchId: null,
      originalProductTotals: new Map(),
      availableStockMap: new Map(),
      totalPurchasedByProduct: new Map(),
      invoices: [majorInv, regularInv],
      constraints: new Map(),
      majorCustomerIds: new Set(["cust-major"]),
    };
    const staticAvailable = new Map([[PRODUCT_A, 20]]);

    const result = computeEditableDayPool(context, staticAvailable, "2026-08-05");

    // 20 total - 3 reserved by the major customer = 17. The regular
    // invoice's own 5kg stays IN the pool (unlike computeAvailableForEdit,
    // which would also subtract it) since it's a valid redistribution
    // target, not a permanent reservation.
    expect(result.get(PRODUCT_A)).toBe(17);
  });

  it("ignores Major Customer invoices on a different day", () => {
    const majorOtherDay = invoiceWithParty(
      "major-1",
      "2026-08-06",
      "cust-major",
      [{ product_id: PRODUCT_A, quantity: 3 }],
    );
    const context: SalesBalanceContext = {
      batchId: "batch-1",
      batchTotal: 0,
      stockSourceBatchId: null,
      originalProductTotals: new Map(),
      availableStockMap: new Map(),
      totalPurchasedByProduct: new Map(),
      invoices: [majorOtherDay],
      constraints: new Map(),
      majorCustomerIds: new Set(["cust-major"]),
    };
    const staticAvailable = new Map([[PRODUCT_A, 20]]);

    const result = computeEditableDayPool(context, staticAvailable, "2026-08-05");
    expect(result.get(PRODUCT_A)).toBe(20);
  });
});
