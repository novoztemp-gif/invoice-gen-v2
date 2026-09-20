import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";
import { validateStockConservation } from "./StockCalculationService";

/**
 * Client-reported bug — "Stock conservation violation" at Sales batch
 * confirmation time, even though generation itself reported success.
 *
 * Root cause: several post-generation "close the drift" / "grow a
 * below-minimum invoice toward thresholdMin" / "force the batch total to
 * match exactly" routines in generateInvoiceSplitupsInternal reused
 * solveLineForTarget to bump an EXISTING line's quantity up — but
 * solveLineForTarget only respects the product's own configured
 * [rate, quantity] range, nothing about real per-date stock
 * (availableStockMap). On a real batch this grew a line's quantity past
 * what was actually available (requested 88.5, available 76.5 for one
 * product on one date) — invisible at generation time (that check only
 * runs later, at persist/confirm time via validateStockConservation in
 * create-sales-batch-transactional), so the batch appeared to generate
 * successfully and only failed later when confirming.
 *
 * Fix: solveLineForTargetWithinStock wraps solveLineForTarget — any
 * growth beyond the line's current quantity is capped to what's really
 * left in availableStockMap for that exact (date, product), with the
 * extra consumption deducted from the map so later lines/invoices in the
 * same run can't also claim it. Wired into every growth call site in
 * generateInvoiceSplitupsInternal (Major Customer drift/max-limit
 * correction, below-minimum invoice growth, and the exact batch-total
 * balancing routine).
 *
 * This test uses TIGHT stock (exactly enough for the naturally generated
 * quantity, no slack) combined with a minimum invoice amount that forces
 * the "grow below-minimum invoices" fallback to engage, then verifies —
 * via the real persisted invoice payload — that no product's total
 * requested quantity on any date ever exceeds its real stock ceiling.
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
    perDayQtyMax: "100",
    perDayRateMin: "10",
    perDayRateMax: "20",
    occurrencePercentage,
    category: "Meat",
  };
}

describe("InvoiceEngine.generateAndSaveInvoices — Sales stock-aware line growth", () => {
  it("no generated line's quantity ever exceeds real per-date stock, even under tight-stock drift/minimum-growth pressure", () => {
    const products = [product("P1", 60), product("P2", 40)];

    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "SALES",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-01-10",
      // A tight minimum relative to a single line's typical amount forces
      // the "grow below-minimum invoices toward thresholdMin" fallback to
      // engage frequently. With only one selected customer (below), at
      // most 10 invoices exist (one per date) — 10 x 900 = 9,000, so
      // total_amount must clear that with real room or the scenario is
      // mathematically infeasible regardless of how correct the growth
      // logic is (confirmed: two independent, unrelated correctness fixes
      // elsewhere this session — removing budgeting "slack" that
      // shouldn't have existed — turned 8,000 from "barely passes by
      // accident" into "fails every one of 100 retries, correctly,
      // because it's genuinely too tight"). Raised to 10,000 to keep this
      // test's real purpose (no oversell during growth) reliably testable
      // without also accidentally asserting a borderline-infeasible total
      // is achievable.
      minimum_invoice_amount: 900,
      maximum_invoice_amount: 2000,
      total_amount: 10000,
      products,
      selected_customers: ["cust-1"],
      major_customers: [],
      category_allocation: null,
      occurrence_semantics: null,
      stock_source_batch_id: "src-batch-1",
    };

    // Tight stock: just enough for a handful of commercial lines per
    // product per day, no generous slack — any uncapped growth attempt
    // would push past this.
    const dates = [
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
    ];
    const ledgerRows = dates.flatMap((d) => [
      {
        purchase_batch_id: "src-batch-1",
        ledger_date: d,
        product_id: "P1",
        opening_stock: 0,
        purchased_quantity: 60,
        sold_quantity: 0,
      },
      {
        purchase_batch_id: "src-batch-1",
        ledger_date: d,
        product_id: "P2",
        opening_stock: 0,
        purchased_quantity: 60,
        sold_quantity: 0,
      },
    ]);

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

    return InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1").then(
      () => {
        expect(rpcCalls.length).toBe(1);
        const invoices = rpcCalls[0].args.p_invoices as any[];

        // Reuses the exact same conservation check the real
        // create-sales-batch-transactional route runs at confirm time —
        // this is what actually caught the client's real bug, so it's
        // what verifies the fix. Stock legitimately carries forward
        // day-to-day when unused (the chronological recurrence this
        // function is built on) — a naive flat per-day sum would produce
        // false positives on later dates, which is exactly why this
        // reuses the real function instead of reimplementing the check.
        const proposedLines = invoices.flatMap((inv) =>
          (inv.products || []).map((p: any) => ({
            product_id: p.product_id,
            ledger_date: inv.invoice_date,
            quantity: Number(p.quantity || 0),
          })),
        );
        const result = validateStockConservation(ledgerRows as any, proposedLines);
        expect(result.valid).toBe(true);
        expect(result.violations).toEqual([]);
      },
    );
  });
});
