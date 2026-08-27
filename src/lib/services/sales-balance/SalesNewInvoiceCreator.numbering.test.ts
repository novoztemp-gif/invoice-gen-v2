import { describe, expect, it } from "vitest";
import { SalesNewInvoiceCreator } from "./SalesNewInvoiceCreator";
import type {
  SalesBalanceContext,
  SalesInvoice,
  SalesProductConstraint,
  SalesSolverPlan,
} from "./types";

/** Same filtering mock used by invoiceSequenceLookup.test.ts / AutoBalanceEngine.numbering.test.ts. */
function makeMockSupabase(allRows: { invoice_number: string }[]) {
  return {
    from(_table: string) {
      let likePattern = "";
      const builder = {
        select(_cols: string) {
          return builder;
        },
        like(_col: string, pattern: string) {
          likePattern = pattern;
          return builder;
        },
        range(from: number, to: number) {
          const prefix = likePattern.replace(/%$/, "");
          const filtered = allRows.filter((r) =>
            r.invoice_number.startsWith(prefix),
          );
          return Promise.resolve({
            data: filtered.slice(from, to + 1),
            error: null,
          });
        },
      };
      return builder;
    },
  } as any;
}

function seq(prefix: string, from: number, to: number) {
  const rows: { invoice_number: string }[] = [];
  for (let n = from; n <= to; n++) {
    rows.push({ invoice_number: `${prefix}-${String(n).padStart(7, "0")}` });
  }
  return rows;
}

const PRODUCT_A = "prod-1";
const PREFIX = "X-2026-27-S";

function makeContext(): SalesBalanceContext {
  // Batch A's own invoices — numbers 1..100 (this batch's own local view).
  // Two DIFFERENT customers so the new invoice has somewhere to land:
  // cust-1's invoice is the "edited" one (marks cust-1 used on its date),
  // cust-2's invoice is untouched (stays eligible as a placement target).
  const inv1: SalesInvoice = {
    id: "inv-1",
    invoice_batch_id: "batch-a",
    invoice_number: `${PREFIX}-0000100`,
    invoice_date: "2026-01-01",
    products: [
      {
        product_id: PRODUCT_A,
        product_name: "Chicken",
        hsn_code: "0207",
        unit_of_measure: "kg",
        category: "Meat",
        quantity: 10,
        rate: 100,
        amount: 1000,
        customer_id: "cust-1",
      },
    ],
    total_amount: 1000,
  };
  const inv2: SalesInvoice = {
    id: "inv-2",
    invoice_batch_id: "batch-a",
    invoice_number: `${PREFIX}-0000099`,
    invoice_date: "2026-01-01",
    products: [
      {
        product_id: PRODUCT_A,
        product_name: "Chicken",
        hsn_code: "0207",
        unit_of_measure: "kg",
        category: "Meat",
        quantity: 8,
        rate: 100,
        amount: 800,
        customer_id: "cust-2",
      },
    ],
    total_amount: 800,
  };

  const constraints = new Map<string, SalesProductConstraint>([
    [
      PRODUCT_A,
      {
        productId: PRODUCT_A,
        category: "Meat",
        unitOfMeasure: "kg",
        quantityMin: 0,
        quantityMax: 1000,
        rateMin: 1,
        rateMax: 1000,
      },
    ],
  ]);

  return {
    batchId: "batch-a",
    batchTotal: 1800,
    thresholdMin: 0,
    thresholdMax: 100000,
    stockSourceBatchId: null,
    originalProductTotals: new Map([[PRODUCT_A, 18]]),
    availableStockMap: new Map(),
    totalPurchasedByProduct: new Map(),
    invoices: [inv1, inv2],
    constraints,
    majorCustomerIds: new Set(),
  };
}

describe("SalesNewInvoiceCreator.createInvoicesForShortfall (Sprint 1.6B)", () => {
  it("TEST 2: Sales cross-batch collision — Batch A (1-100) + Batch B (101-150), same company+FY+type — new invoice must be 151, not 101", async () => {
    const context = makeContext();
    // The full invoice table contains both Batch A's (1-100) and Batch B's
    // (101-150) rows sharing the same company+FY+type prefix.
    const supabase = makeMockSupabase(seq(PREFIX, 1, 150));

    const plan: SalesSolverPlan = {
      editedInvoice: context.invoices[0], // inv-1 (cust-1) — unchanged here, just the "current edit"
      balancingInvoices: [],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map([[PRODUCT_A, 5]]), // 5kg with nowhere else to go
    };

    const result = await SalesNewInvoiceCreator.createInvoicesForShortfall(
      supabase,
      context,
      plan,
    );

    expect(result.newInvoices.length).toBe(1);
    expect(result.newInvoices[0].invoice_number).toBe(`${PREFIX}-0000151`);
    // Placed on the only eligible customer for that date (cust-1 is
    // already "used" on 2026-01-01 via the edited invoice itself).
    expect(result.newInvoices[0].products[0].customer_id).toBe("cust-2");
  });

  it("TEST 9: existing invoice numbers are never changed by new-invoice creation", async () => {
    const context = makeContext();
    const originalNumbers = context.invoices.map((i) => i.invoice_number);
    const supabase = makeMockSupabase(seq(PREFIX, 1, 150));

    const plan: SalesSolverPlan = {
      editedInvoice: context.invoices[0],
      balancingInvoices: [],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map([[PRODUCT_A, 5]]),
    };

    await SalesNewInvoiceCreator.createInvoicesForShortfall(
      supabase,
      context,
      plan,
    );

    // createInvoicesForShortfall only ever pushes to a fresh `newInvoices`
    // array — context.invoices (the existing, already-persisted invoices)
    // is never mutated or renumbered.
    expect(context.invoices.map((i) => i.invoice_number)).toEqual(
      originalNumbers,
    );
  });

  it("multiple companies/FYs/types in the invoice table do not affect the Sales prefix's own next sequence", async () => {
    const context = makeContext();
    const rows = [
      ...seq(PREFIX, 1, 150), // this company/FY/Sales — the one that matters
      ...seq("X-2026-27-P", 1, 900), // same company/FY but Purchase — must be ignored
      ...seq("X-2025-26-S", 1, 900), // same company/type but different FY — must be ignored
      ...seq("Y-2026-27-S", 1, 900), // different company — must be ignored
    ];
    const supabase = makeMockSupabase(rows);

    const plan: SalesSolverPlan = {
      editedInvoice: context.invoices[0],
      balancingInvoices: [],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map([[PRODUCT_A, 5]]),
    };

    const result = await SalesNewInvoiceCreator.createInvoicesForShortfall(
      supabase,
      context,
      plan,
    );

    expect(result.newInvoices[0].invoice_number).toBe(`${PREFIX}-0000151`);
  });
});
