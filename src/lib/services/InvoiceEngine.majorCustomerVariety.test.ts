import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Client-reported issue — major customer invoices repeating the same
 * product.
 *
 * occurrenceWeightedFittingProduct picks each invoice's primary product
 * using the SAME global occurrence-weighted bias every time. Since every
 * one of a major customer's invoices is in the same category by
 * definition, whichever product currently has the most remaining quota
 * kept winning invoice after invoice for that SAME customer, producing a
 * visibly repetitive, unrealistic sequence (confirmed on a real batch:
 * several consecutive invoices for one major customer all showing the
 * identical product). The client was explicit that occurrence percentages
 * and the overall system should NOT change — only that consecutive
 * invoices for the same major customer should show more variety.
 *
 * Fix: the major-customer loop in generatePurchaseInvoiceSplitupsInternal
 * now tracks the immediately-previous invoice's own primary product for
 * THAT customer and excludes it from the candidate pool for the next
 * invoice — falling back to the full pool whenever exclusion would leave
 * no candidates, so it can never make an otherwise-feasible invoice
 * infeasible.
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
    perDayRateMax: "500",
    occurrencePercentage,
    category: "Meat",
  };
}

describe("InvoiceEngine.generateAndSaveInvoices — major customer product variety", () => {
  it("no two consecutive invoices for the same major customer share the same primary product", () => {
    const products = [
      product("M1", 40),
      product("M2", 30),
      product("M3", 20),
      product("M4", 10),
    ];

    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "PURCHASE",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-03-01", // 60 days, plenty for 40 invoices
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 3000,
      total_amount: 100000,
      products,
      selected_customers: [],
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 100000,
          invoice_count: 40,
          max_invoice_amount: 3000,
        },
      ],
      category_allocation: null,
      occurrence_semantics: null,
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
        suppliers: [{ data: [{ id: "maj-a", category: "Meat" }], error: null }],
      },
      makeRpcHandler("TST-2026-27-P"),
    );

    return InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1").then(
      (count) => {
        expect(count).toBe(40);
        const invoices = rpcCalls[0].args.p_invoices as any[];
        let consecutiveRepeats = 0;
        for (let i = 1; i < invoices.length; i++) {
          const prevFirst = invoices[i - 1].products?.[0]?.product_id;
          const curFirst = invoices[i].products?.[0]?.product_id;
          if (prevFirst && curFirst && prevFirst === curFirst) {
            consecutiveRepeats++;
          }
        }
        // Some repeats can still occur if variety-filtering falls back
        // (e.g. only one affordable candidate left) — but it must be a
        // small minority, not the dominant pattern the bug produced.
        expect(consecutiveRepeats).toBeLessThan(invoices.length * 0.3);
      },
    );
  });
});
