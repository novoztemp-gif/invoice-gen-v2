import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Same generic chainable query-builder mock used across the numbering test
 * files (InvoiceEngine.atomicNumbering.test.ts etc.) — each `.from(table)`
 * call consumes the NEXT queued response for that table, in call order.
 * Also tracks how many times each table/rpc was actually invoked, which is
 * exactly what this file needs to prove "generation never started."
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
        "delete",
        "insert",
        "limit",
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

  return { supabase: supabase as any, rpcCalls, counters };
}

function makePurchaseBatchRow(
  productsOccurrence: Array<{ productId: string; occurrencePercentage: number }>,
  overrides: Record<string, any> = {},
) {
  return {
    id: "batch-1",
    issuing_company_id: "co-1",
    financial_year: "2026-27",
    batch_status: "draft",
    batch_type: "PURCHASE",
    invoice_date_from: "2026-01-01",
    invoice_date_to: "2026-01-05",
    minimum_invoice_amount: 100,
    maximum_invoice_amount: 100000,
    total_amount: 3000,
    products: productsOccurrence.map((p, i) => ({
      product_id: p.productId,
      product_name: p.productId,
      hsn_code: "0207",
      unit_of_measure: "kg",
      perDayQtyMin: "10",
      perDayQtyMax: "100",
      perDayRateMin: "10",
      perDayRateMax: "500",
      occurrencePercentage: p.occurrencePercentage,
      category: "Meat",
    })),
    selected_customers: [],
    major_customers: [
      {
        customer_id: "maj-a",
        amount: 3000,
        invoice_count: 3,
        max_invoice_amount: 2000,
      },
    ],
    ...overrides,
  };
}

describe("InvoiceEngine.generateAndSaveInvoices — server-side occurrence configuration gate (Sprint 1.7C)", () => {
  it("VALID configuration (single 100% product): validation passes, generation proceeds to completion", async () => {
    // Sprint 1.7N added a second, POST-generation occurrence gate
    // (target-vs-actual, not just config-shape) — a multi-product 50/30/20
    // split relies on selectProductsByOccurrence's weighted RANDOM draw,
    // which (as Sprint 1.7M's investigation found) is not guaranteed to
    // hit exact targets over only 3 invoices. A single 100%-occurrence
    // product is deterministic instead: it is the only candidate, so it
    // necessarily appears on every generated invoice, always exactly
    // matching its target regardless of any random draw — preserving this
    // test's original intent (valid config -> generation proceeds) without
    // depending on random-selection luck.
    const batchRow = makePurchaseBatchRow([
      { productId: "A", occurrencePercentage: 100 },
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
          { data: [], error: null }, // auto-detect scan: no existing invoices
          { data: [], error: null }, // STEP 4 readback
        ],
        suppliers: [{ data: [{ id: "maj-a", category: "Meat" }], error: null }],
      },
      (fnName, args) => {
        const invoices = args.p_invoices as any[];
        return {
          data: invoices.map((_inv, i) => ({
            invoice_number: `TST-2026-27-P-${String(i + 1).padStart(7, "0")}`,
            sequence_number: i + 1,
          })),
          error: null,
        };
      },
    );

    const count = await InvoiceEngine.generateAndSaveInvoices(
      supabase,
      "batch-1",
    );

    expect(count).toBe(3); // 3 major-customer invoices, generation ran normally
    expect(rpcCalls.length).toBe(1); // atomic commit was reached — proves generation proceeded
  });

  it("INVALID configuration (50/30, sums to 80%): validation fails BEFORE generation ever starts", async () => {
    const batchRow = makePurchaseBatchRow([
      { productId: "A", occurrencePercentage: 50 },
      { productId: "B", occurrencePercentage: 30 },
    ]);

    const { supabase, rpcCalls, counters } = makeMockSupabase(
      {
        invoice_batch: [{ data: batchRow, error: null }],
        issuing_companies: [
          { data: { abbreviation: "TST", company_name: "Test Co" }, error: null },
        ],
        // No "invoice" or "suppliers" queue entries at all — if generation
        // reached the auto-detect scan or supplier fetch, it would consume
        // the default { data: null, error: null } fallback and the
        // counters below would show it happened.
      },
      () => {
        throw new Error(
          "RPC must never be called when occurrence configuration is invalid",
        );
      },
    );

    await expect(
      InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1"),
    ).rejects.toThrow(/Product Occurrence Configuration Invalid/);

    // Proves generation never started: no auto-detect scan, no supplier
    // fetch, no atomic commit, no delete/insert.
    expect(counters["invoice"] || 0).toBe(0);
    expect(counters["suppliers"] || 0).toBe(0);
    expect(rpcCalls.length).toBe(0);
  });

  it("INVALID configuration (missing occurrencePercentage on one product): rejected with a specific, actionable message", async () => {
    const batchRow = makePurchaseBatchRow([
      { productId: "A", occurrencePercentage: 100 },
    ]);
    delete (batchRow.products[0] as any).occurrencePercentage;

    const { supabase, rpcCalls } = makeMockSupabase(
      {
        invoice_batch: [{ data: batchRow, error: null }],
        issuing_companies: [
          { data: { abbreviation: "TST", company_name: "Test Co" }, error: null },
        ],
      },
      () => {
        throw new Error("RPC must never be called");
      },
    );

    await expect(
      InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1"),
    ).rejects.toThrow(/occurrence percentage is required/);
    expect(rpcCalls.length).toBe(0);
  });
});
