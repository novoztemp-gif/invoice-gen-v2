import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Client-approved hotfix — small statistical tolerance for large batches.
 *
 * After a long sequence of structural fixes (implied category split,
 * per-category avg-lines calibration, per-invoice/affordability capping,
 * iterated exact-match repair, larger retry budget) each confirmed via
 * real production log data to close large, genuine occurrence violations
 * on a real 1011-invoice batch, a small residual remained: on a batch with
 * ~30 simultaneous product targets, most products landed within +-1 to
 * +-3 of target, with the validator still rejecting because it demanded a
 * PERFECT simultaneous integer match. The client was asked directly
 * whether a small tolerance was acceptable given how close batches were
 * landing, and explicitly approved it (see conversation this fix shipped
 * in) rather than continuing to chase an exact match indefinitely.
 *
 * `checkProductOccurrenceGate` now allows each product a small band (8%
 * of its own target, minimum 2) before counting it as a real violation —
 * but ONLY once the batch has >=100 real invoices, so the "statistical
 * noise across many simultaneous targets" justification actually applies.
 * Smaller batches (a handful of invoices/products, where a deviation of 1
 * is still a large fraction of a small target) keep the pre-existing
 * exact, zero-tolerance check untouched — see
 * InvoiceEngine.occurrenceGate.test.ts, which still exercises small
 * batches and must keep failing on small deviations.
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

function product(id: string, occurrencePercentage: number, category: "Meat" | "Fruits") {
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

describe("InvoiceEngine.generateAndSaveInvoices — large-batch statistical tolerance", () => {
  it("a large (150+ invoice) batch with many competing same-category products reliably passes", () => {
    const products = [
      product("M1", 20, "Meat"),
      product("M2", 15, "Meat"),
      product("M3", 12, "Meat"),
      product("M4", 10, "Meat"),
      product("M5", 8, "Meat"),
      product("M6", 8, "Meat"),
      product("M7", 6, "Meat"),
      product("F1", 10, "Fruits"),
      product("F2", 6, "Fruits"),
      product("F3", 5, "Fruits"),
    ];

    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "PURCHASE",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-08-31",
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 2000,
      total_amount: 500000,
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
        expect(count).toBeGreaterThan(100);
        expect(rpcCalls.length).toBe(1); // gate passed, persistence reached
      },
    );
  });
});
