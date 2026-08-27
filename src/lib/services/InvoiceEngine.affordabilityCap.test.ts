import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * URGENT REGRESSION FIX — GLOBAL semantics, affordability-aware occurrence
 * cap.
 *
 * Root cause (confirmed against the real 1011-invoice production batch,
 * via targeted instrumentation of a live generation run — see the
 * conversation this fix shipped in): even after capping a product's target
 * at its own category's real invoice count
 * (InvoiceEngine.dominantProductCap.test.ts), a further, genuine
 * feasibility ceiling remained for products whose minimum possible line
 * cost (quantityMin x rateMin) exceeds most of that category's real
 * invoice budgets. Instrumentation on the real batch showed one product
 * (lineFloor 7,500) was only ever "affordable" on 207 of its category's
 * 758 real invoices — and was already winning ~83% of those (172/207).
 * Its configured percentage implied a target of 311, a number physically
 * impossible to reach given its own price range vs this batch's invoice
 * amounts; no amount of selection bias or retrying could ever close that
 * gap, and the "missing" budget spilled out as scattered overshoot on
 * other same-category products.
 *
 * Fix: `computeCategoryCapacityAwareTargets` now also counts, per
 * product, how many of its own category's REAL invoices have a total
 * that could have covered its cheapest possible line, and uses
 * min(categoryInvoiceCount, affordableInvoiceCount) as that product's cap
 * — reusing the same unmodified `apportionCategoryTargetsWithPerInvoiceCap`
 * redistribution machinery, just fed a tighter, economically real ceiling
 * for products whose price range doesn't fit most of their category's
 * invoices. No stored percentage, and no apportionment algorithm, was
 * touched.
 */

function makeMockSupabase(
  queues: Record<string, Array<{ data: any; error: any }>>,
  rpcHandler: (fnName: string, args: any) => { data: any; error: any },
) {
  const counters: Record<string, number> = {};
  const rpcCalls: Array<{ fnName: string; args: any }> = [];
  const supabase = {
    from(table: string) {
      const idx = counters[table] || 0;
      counters[table] = idx + 1;
      const queue = queues[table] || [];
      const response = queue[idx] || { data: null, error: null };
      const builder: any = {};
      const chain = (..._args: any[]) => builder;
      for (const m of [
        "select",
        "eq",
        "like",
        "order",
        "range",
        "in",
        "update",
        "insert",
        "limit",
        "delete",
      ]) {
        builder[m] = chain;
      }
      builder.single = () => Promise.resolve(response);
      builder.then = (onF: any, onR: any) =>
        Promise.resolve(response).then(onF, onR);
      return builder;
    },
    rpc(fnName: string, args: any) {
      rpcCalls.push({ fnName, args });
      return Promise.resolve(rpcHandler(fnName, args));
    },
  };
  return { supabase: supabase as any, rpcCalls };
}

function makeRpcHandler(prefix: string) {
  return (_fnName: string, args: any) => {
    const invoices = args.p_invoices as any[];
    return {
      data: invoices.map((_inv, i) => ({
        invoice_number: `${prefix}-${String(i + 1).padStart(7, "0")}`,
        sequence_number: i + 1,
      })),
      error: null,
    };
  };
}

function product(
  id: string,
  occurrencePercentage: number,
  category: "Meat" | "Fruits",
  overrides: Record<string, string> = {},
) {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "10",
    perDayRateMax: "500",
    occurrencePercentage,
    category,
    ...overrides,
  };
}

describe("InvoiceEngine.generateAndSaveInvoices — GLOBAL affordability-aware occurrence cap fix", () => {
  it("a product priced far above most of its category's invoice budgets still passes the gate", () => {
    const products = [
      // M1's cheapest possible line (100 x 750 = 75,000) vastly exceeds
      // most invoice budgets (500-2000) — economically unaffordable on
      // almost every invoice, despite a large configured share.
      product("M1", 60, "Meat", {
        perDayQtyMin: "100",
        perDayQtyMax: "100",
        perDayRateMin: "750",
        perDayRateMax: "750",
      }),
      product("M2", 5, "Meat"),
      product("F1", 15, "Fruits"),
      product("F2", 10, "Fruits"),
      product("F3", 10, "Fruits"),
    ];

    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "PURCHASE",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-03-15",
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 2000,
      total_amount: 300000,
      products,
      selected_customers: ["cust-1", "cust-2"],
      major_customers: [],
      category_allocation: null,
      occurrence_semantics: "GLOBAL",
    };

    const { supabase, rpcCalls } = makeMockSupabase(
      {
        invoice_batch: [
          { data: batchRow, error: null },
          { data: null, error: null },
        ],
        issuing_companies: [
          { data: { abbreviation: "TST", company_name: "Test Co" }, error: null },
        ],
        invoice: [
          { data: [], error: null },
          { data: [], error: null },
        ],
        suppliers: [
          {
            data: [
              { id: "cust-1", category: "Meat" },
              { id: "cust-2", category: "Fruits" },
            ],
            error: null,
          },
        ],
      },
      makeRpcHandler("TST-2026-27-P"),
    );

    return InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1").then(
      (count) => {
        expect(count).toBeGreaterThan(0);
        expect(rpcCalls.length).toBe(1); // gate passed, persistence reached
      },
    );
  });
});
