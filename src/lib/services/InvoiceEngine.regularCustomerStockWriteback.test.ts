import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";
import { validateStockConservation } from "./StockCalculationService";

/**
 * Client-reported bug, confirmed on a real 403-invoice/48-product Sales
 * batch by reconciling the actual saved invoices day-by-day against the
 * linked Purchase batch's real daily_stock_ledger rows: several products
 * were sold in quantities exceeding what was ever purchased that exact
 * day, with no leftover/carry-forward source to explain it (e.g. one
 * product: 333.75kg purchased on a given date, 604.75kg sold that same
 * date — a 271kg oversell).
 *
 * Root cause: the day-by-day REGULAR (non-major) customer generation loop
 * in generateInvoiceSplitupsInternal decides each day's qtyToSell against
 * `available` (read from the shared availableStockMap) and tracks
 * day-to-day carryover via its own PRIVATE `runningRemaining` map — but
 * never reported that consumption back into the SHARED availableStockMap
 * itself. Every other stock-aware pass in the same function (Major
 * Customer processing, the "Exact Batch Total Balancing Routine",
 * solveLineForTargetWithinStock's own growth cap) reads that SAME shared
 * map to decide how much room is really left — so with the regular loop's
 * spending invisible to it, a later pass could "discover" stock that was
 * already fully committed to regular invoices and grow a line into it a
 * second time.
 *
 * The precise diagnosis above came from reconciling the real production
 * files (not from this test) — generation is heavily randomized, so a
 * small synthetic scenario doesn't reliably reproduce the exact same-day
 * regrowth on the old code every run. This test instead stands as a
 * general invariant guard: tight stock, a Total Amount that pressures the
 * Exact Batch Total Balancing Routine to grow existing lines, and an
 * assertion that the fully generated-and-saved batch never oversells.
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

function product(id: string, occurrencePercentage: number) {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "80",
    perDayRateMin: "20",
    perDayRateMax: "40",
    occurrencePercentage,
    category: "Meat",
  };
}

describe("InvoiceEngine.generateAndSaveInvoices — regular-customer loop reports its own stock consumption", () => {
  it("the Exact Batch Total Balancing Routine never grows a line past what the regular day-by-day loop already fully sold", () => {
    const products = [
      product("P1", 25),
      product("P2", 25),
      product("P3", 25),
      product("P4", 25),
    ];

    const dates = [
      "2026-02-01",
      "2026-02-02",
      "2026-02-03",
      "2026-02-04",
      "2026-02-05",
      "2026-02-06",
      "2026-02-07",
    ];

    // Tight, exact daily stock — no slack. If the day-by-day loop sells
    // 100% of a day's stock (which a tight budget/no-carryover scenario
    // naturally does) and a later pass grows a line for that same
    // (date, product) at all, it has nowhere to come from but oversell.
    const ledgerRows = dates.flatMap((d) => [
      { purchase_batch_id: "src-batch-2", ledger_date: d, product_id: "P1", opening_stock: 0, purchased_quantity: 40, sold_quantity: 0 },
      { purchase_batch_id: "src-batch-2", ledger_date: d, product_id: "P2", opening_stock: 0, purchased_quantity: 40, sold_quantity: 0 },
      { purchase_batch_id: "src-batch-2", ledger_date: d, product_id: "P3", opening_stock: 0, purchased_quantity: 40, sold_quantity: 0 },
      { purchase_batch_id: "src-batch-2", ledger_date: d, product_id: "P4", opening_stock: 0, purchased_quantity: 40, sold_quantity: 0 },
    ]);

    const batchRow = {
      id: "batch-2",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "SALES",
      invoice_date_from: dates[0],
      invoice_date_to: dates[dates.length - 1],
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 3000,
      // High relative to what a purely random-rate first pass naturally
      // lands on (rates are drawn uniformly across [20, 40], averaging
      // ~30, not the 40,800-theoretical-ceiling's implied 40), so the
      // Exact Batch Total Balancing Routine has real pressure to grow
      // lines toward the target rather than trivially landing on it —
      // without asking for so much of the 44,800 theoretical maximum
      // (every kg of real stock priced at the absolute ceiling rate) that
      // the batch/invoice caps make it genuinely unreachable regardless of
      // how correct the stock accounting is.
      total_amount: 30000,
      products,
      selected_customers: ["cust-1", "cust-2", "cust-3"],
      major_customers: [],
      category_allocation: null,
      occurrence_semantics: null,
      stock_source_batch_id: "src-batch-2",
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
        daily_stock_ledger: [{ data: ledgerRows, error: null }],
      },
      makeRpcHandler("TST-2026-27-S"),
    );

    return InvoiceEngine.generateAndSaveInvoices(supabase, "batch-2").then(
      () => {
        expect(rpcCalls.length).toBe(1);
        const invoices = rpcCalls[0].args.p_invoices as any[];

        const proposedLines = invoices.flatMap((inv) =>
          (inv.products || []).map((p: any) => ({
            product_id: p.product_id,
            ledger_date: inv.invoice_date,
            quantity: Number(p.quantity || 0),
          })),
        );
        const result = validateStockConservation(
          ledgerRows as any,
          proposedLines,
        );
        expect(result.violations).toEqual([]);
        expect(result.valid).toBe(true);
      },
    );
  });
});
