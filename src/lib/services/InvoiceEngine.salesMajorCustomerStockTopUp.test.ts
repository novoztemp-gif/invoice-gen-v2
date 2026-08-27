import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Client-reported bug — Sales Major Customer balancing failing far short
 * of the configured amount even though enough stock existed overall.
 *
 * Root cause: each Major Customer invoice only ever tried a random 3-8
 * product SAMPLE drawn from the category (chosenProducts, via
 * selectProductsByOccurrence) — if those specific products happened to be
 * low on real remaining stock, the invoice fell far short of its target
 * budget even when OTHER products in the same category still had plenty
 * of stock, because nothing ever pulled them in. On a real batch this
 * produced "Major Customer balancing failed: expected Rs237882, got
 * Rs49500" — a persistent (survives every retry), large shortfall, not
 * random noise. The client's own diagnosis ("major customer should get
 * priority — whatever the cost and stock is") was correct in spirit: the
 * code already processed Major Customers first for both money and stock
 * (STEP 1, "Reserving Stock"), but a single invoice's own product search
 * was too narrow to actually claim stock sitting in products outside its
 * initial random sample.
 *
 * Fix: after the initial chosenProducts pass, a top-up pass now pulls in
 * the REST of the category's products (sorted by real remaining stock,
 * descending) whenever the invoice is still short of its target budget —
 * so a Major Customer invoice now claims stock from anywhere in its
 * category, not just its initial random sample. Purchase's equivalent
 * loop already did this (selectProductsForBudgetCapacity dynamically
 * sizes its candidate list to the target budget) — this brings Sales up
 * to the same behavior for the dimension that matters there: real stock,
 * not just capacity.
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
  overrides: Record<string, string> = {},
) {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "50",
    perDayRateMin: "10",
    perDayRateMax: "20",
    occurrencePercentage,
    category: "Meat",
    ...overrides,
  };
}

describe("InvoiceEngine.generateAndSaveInvoices — Sales Major Customer stock top-up fix", () => {
  it("a Major Customer invoice reaches its target budget by claiming stock outside its initial random product sample", () => {
    // 9 products with only enough stock for ~1 minimal line each (~10
    // units x ~15 avg rate =~ 150 each, ~1350 total across all 9) and one
    // "BIG" product with ample stock — the major customer's amount
    // (30000) is only reachable by using BIG, which a naive 3-8 random
    // sample frequently misses.
    const products = [
      // BIG can produce a single line up to 2000 x 20 = 40,000 — large
      // enough to cover the whole target alone, IF the top-up pass
      // actually reaches it. The 9 "M" products cap out at 50 x 20 = 1000
      // each (9,000 total) — nowhere near the 30,000 target on their own,
      // so reaching it genuinely requires claiming BIG's stock.
      product("BIG", 20, { perDayQtyMax: "2000" }),
      ...Array.from({ length: 9 }, (_, i) => product(`M${i + 1}`, 80 / 9)),
    ];

    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "SALES",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-01-01",
      minimum_invoice_amount: 100,
      maximum_invoice_amount: 100000,
      total_amount: 30000,
      products,
      selected_customers: [],
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 30000,
          invoice_count: 1,
          max_invoice_amount: 30000,
        },
      ],
      category_allocation: null,
      occurrence_semantics: null,
      stock_source_batch_id: "src-batch-1",
    };

    const ledgerRows = [
      {
        purchase_batch_id: "src-batch-1",
        ledger_date: "2026-01-01",
        product_id: "BIG",
        opening_stock: 100000,
        purchased_quantity: 0,
        sold_quantity: 0,
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        purchase_batch_id: "src-batch-1",
        ledger_date: "2026-01-01",
        product_id: `M${i + 1}`,
        opening_stock: 10, // only enough for one minimal line
        purchased_quantity: 0,
        sold_quantity: 0,
      })),
    ];

    const { supabase, rpcCalls } = makeMockSupabase(
      {
        invoice_batch: [
          { data: batchRow, error: null },
          { data: null, error: null },
        ],
        issuing_companies: [
          { data: { abbreviation: "TST", company_name: "Test Co" }, error: null },
        ],
        invoice: [{ data: [], error: null }],
        daily_stock_ledger: [{ data: ledgerRows, error: null }],
      },
      makeRpcHandler("TST-2026-27-S"),
    );

    return InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1").then(
      (count) => {
        expect(count).toBe(1);
        expect(rpcCalls.length).toBe(1); // reached persistence — balancing passed
      },
    );
  });
});
