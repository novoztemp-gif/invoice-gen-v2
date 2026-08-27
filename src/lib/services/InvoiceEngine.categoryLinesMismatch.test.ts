import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * URGENT REGRESSION FIX — GLOBAL semantics per-category avg-lines/invoice
 * mismatch (the residual failure that survived the category-split fix).
 *
 * Root cause (confirmed against the real 1011-invoice production batch's
 * own dev-server log): the category-split fix made each category receive
 * its proportionally correct SHARE OF INVOICES, but a further, independent
 * mismatch remained in checkProductOccurrenceGate/repairOccurrenceDeviations
 * and the occurrenceLedger seeding — GLOBAL product targets were still
 * computed as `occurrencePercentage% of the WHOLE BATCH's product-line
 * slots`, using ONE shared whole-batch average lines/invoice. Category
 * purity means a product can only occupy slots on its own category's
 * invoices, and different categories can realize materially different real
 * average lines/invoice (e.g. a category with fewer eligible products caps
 * how many distinct lines its own invoices can carry) — a flat shared
 * average silently over-sizes one category's targets and under-sizes the
 * other's, a purely dimensional capacity ceiling no amount of selection
 * bias or retrying can close. This reproduced the real batch's exact
 * failure shape: some products (typically in the category with fewer
 * eligible products, hence a lower real avg lines/invoice) landing far
 * below target while others simultaneously landed far above.
 *
 * Fix: `computeCategoryCapacityAwareTargets` now derives each category's
 * own slot-count target from that category's OWN measured average
 * lines/invoice (not the whole batch's), while still deriving the
 * category's invoice-count target from the same sum-of-percentages
 * apportionment already used for categoryLedger — so the check still
 * catches a category receiving the wrong invoice SHARE (unchanged
 * behavior, see InvoiceEngine.categorySplitMismatch.test.ts), just no
 * longer mis-scaled by a shared average when categories structurally
 * differ in lines/invoice. No stored percentage, and no
 * apportionment/rounding algorithm, was touched — only what count feeds
 * that existing, unmodified algorithm.
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
  };
}

describe("InvoiceEngine.generateAndSaveInvoices — GLOBAL per-category avg-lines/invoice mismatch fix", () => {
  it("Fruits has only 1 eligible product (forced avgLines=1) while Meat has 6 (avgLines 3-8): gate still passes", () => {
    const products = [
      product("M1", 15, "Meat"),
      product("M2", 15, "Meat"),
      product("M3", 15, "Meat"),
      product("M4", 15, "Meat"),
      product("M5", 10, "Meat"),
      product("M6", 10, "Meat"),
      product("F1", 20, "Fruits"),
    ];

    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "PURCHASE",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-03-01",
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
