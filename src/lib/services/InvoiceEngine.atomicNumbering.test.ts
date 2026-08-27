import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Generic chainable query-builder mock. Each `.from(table)` call consumes
 * the NEXT queued response for that table (in call order) — this mirrors
 * the exact sequence of Supabase calls `generateAndSaveInvoices` makes,
 * without needing to reimplement real filtering/ordering logic.
 */
function makeMockSupabase(
  queues: Record<string, Array<{ data: any; error: any }>>,
  rpcHandler: (fnName: string, args: any) => { data: any; error: any },
) {
  const counters: Record<string, number> = {};
  const rpcCalls: Array<{ fnName: string; args: any }> = [];
  const deleteCalls: Array<{ table: string }> = [];

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
      ]) {
        builder[m] = chain;
      }
      builder.delete = (..._args: any[]) => {
        deleteCalls.push({ table });
        return builder;
      };
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

  return { supabase: supabase as any, rpcCalls, deleteCalls };
}

function makePurchaseBatchRow(overrides: Record<string, any> = {}) {
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
    products: [
      {
        product_id: "prod-1",
        product_name: "Chicken",
        hsn_code: "0207",
        unit_of_measure: "kg",
        perDayQtyMin: "10",
        perDayQtyMax: "100",
        perDayRateMin: "10",
        perDayRateMax: "500",
        occurrencePercentage: 100,
        category: "Meat",
      },
    ],
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

describe("InvoiceEngine.generateAndSaveInvoices — atomic sequence allocation (Sprint 1.6C)", () => {
  it("auto-detect path (no manual override): reserves+inserts via the atomic RPC, not a plain non-atomic insert", async () => {
    const batchRow = makePurchaseBatchRow(); // no previous_ending_sequence set

    const { supabase, rpcCalls, deleteCalls } = makeMockSupabase(
      {
        invoice_batch: [
          { data: batchRow, error: null }, // initial fetch
          { data: null, error: null }, // final status update
        ],
        issuing_companies: [
          { data: { abbreviation: "TST", company_name: "Test Co" }, error: null },
        ],
        invoice: [
          // Auto-detect MAX scan: 50 pre-existing invoices for this prefix.
          {
            data: Array.from({ length: 50 }, (_, i) => ({
              invoice_number: `TST-2026-27-P-${String(i + 1).padStart(7, "0")}`,
            })),
            error: null,
          },
          // Sprint 1.6E: no separate client-side delete call on this path
          // anymore — the RPC now owns the delete (after inspecting the
          // batch's old invoices for safe trailing-range reuse), so the
          // very next "invoice" table call is the STEP 4 readback.
          { data: [], error: null }, // STEP 4 readback select
        ],
        suppliers: [{ data: [{ id: "maj-a", category: "Meat" }], error: null }],
      },
      (fnName, args) => {
        expect(fnName).toBe("commit_invoice_batch_with_sequences");
        const invoices = args.p_invoices as any[];
        return {
          data: invoices.map((_inv, i) => ({
            invoice_number: `TST-2026-27-P-${String(51 + i).padStart(7, "0")}`,
            sequence_number: 51 + i,
          })),
          error: null,
        };
      },
    );

    const count = await InvoiceEngine.generateAndSaveInvoices(
      supabase,
      "batch-1",
    );

    expect(count).toBe(3);
    expect(rpcCalls.length).toBe(1);
    expect(rpcCalls[0].fnName).toBe("commit_invoice_batch_with_sequences");
    expect(rpcCalls[0].args.p_batch_id).toBe("batch-1");
    expect(rpcCalls[0].args.p_issuing_company_id).toBe("co-1");
    expect(rpcCalls[0].args.p_invoice_type).toBe("P");
    expect(rpcCalls[0].args.p_invoices.length).toBe(3);

    // Sprint 1.6E: the client no longer deletes this batch's invoices
    // itself on the atomic path — the RPC does it (after inspecting the
    // old range for safe reuse), so nothing here should call
    // .delete() on "invoice" directly.
    expect(deleteCalls.filter((c) => c.table === "invoice").length).toBe(0);
  });

  it("manual-override path (previous_ending_sequence set): uses the plain non-atomic insert with a client-side delete first, RPC is never called", async () => {
    const batchRow = makePurchaseBatchRow({
      previous_ending_sequence: 50,
    } as any);

    const { supabase, rpcCalls, deleteCalls } = makeMockSupabase(
      {
        invoice_batch: [
          { data: batchRow, error: null },
          { data: null, error: null },
        ],
        issuing_companies: [
          { data: { abbreviation: "TST", company_name: "Test Co" }, error: null },
        ],
        invoice: [
          // No auto-detect scan call at all when previous_ending_sequence
          // is set — the very first "invoice" table call here is the
          // delete, then the plain insert, then the STEP 4 readback.
          { data: null, error: null }, // delete
          { data: null, error: null }, // plain insert
          { data: [], error: null }, // STEP 4 readback select
        ],
        suppliers: [{ data: [{ id: "maj-a", category: "Meat" }], error: null }],
      },
      () => {
        throw new Error(
          "RPC must never be called on the manual-override path",
        );
      },
    );

    const count = await InvoiceEngine.generateAndSaveInvoices(
      supabase,
      "batch-1",
    );

    expect(count).toBe(3);
    expect(rpcCalls.length).toBe(0);
    // This path never had a "reuse trailing range" concept — it still
    // deletes client-side first, exactly as before Sprint 1.6E.
    expect(deleteCalls.filter((c) => c.table === "invoice").length).toBe(1);
  });
});
