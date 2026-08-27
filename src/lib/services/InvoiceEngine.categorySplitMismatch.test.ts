import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * URGENT REGRESSION FIX — GLOBAL semantics category-split mismatch.
 *
 * Root cause (confirmed by direct investigation on a batch matching real
 * production shape — GLOBAL semantics, both Meat and Fruits products
 * present): category PURITY (an invoice only ever contains one category)
 * is enforced unconditionally, but WHICH category an invoice gets was
 * decided by an entirely separate, money-value-weighted split
 * (pickCategoryFromLedger's fallback / plain round-robin), while each
 * product's GLOBAL occurrence target is computed against the WHOLE
 * batch's invoice count. Those two are only compatible by coincidence: if
 * Meat products together configure 70% occurrence share but the money
 * split only ever routes 30% of invoices to Meat, Meat's own targets are
 * mathematically unreachable no matter how well products are picked
 * WITHIN Meat invoices (and the Fruits side ends up starved the same way
 * in reverse) — this produced the reported large, simultaneous
 * over/under-shoots on a real batch (e.g. target 684, actual 141 for one
 * heavily-weighted category).
 *
 * Fix: derive an implied category split from the SUM of each category's
 * own configured occurrence percentages (the same Largest-Remainder
 * apportionment already used for CATEGORY semantics, applied to two
 * synthetic "Meat"/"Fruits" pseudo-products) and seed categoryLedger from
 * that under GLOBAL semantics too, whenever multiple categories are
 * present — making category selection consistent with what the GLOBAL
 * targets actually need. No stored percentage, and no target-calculation
 * algorithm, was touched — only what count/split feeds the existing,
 * unmodified apportionment.
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

describe("InvoiceEngine.generateAndSaveInvoices — GLOBAL category-split mismatch fix", () => {
  it("Meat products configured with 70% combined occurrence share generate successfully despite an unrelated money-weighted category split", () => {
    const products = [
      product("M1", 35, "Meat"),
      product("M2", 35, "Meat"),
      product("F1", 15, "Fruits"),
      product("F2", 15, "Fruits"),
    ];
    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "PURCHASE",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-01-30",
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 2000,
      total_amount: 300000,
      products,
      // Both categories need a real supplier configured, or an invoice
      // routed to that category is silently skipped by an unrelated,
      // pre-existing guard (Purchase invoices require a category-matched
      // supplier to attach to) — not something this fix changes, but a
      // fixture requirement for a valid multi-category Purchase batch.
      selected_customers: ["cust-1", "cust-2"],
      major_customers: [],
      category_allocation: null,
      occurrence_semantics: "GLOBAL",
      receiving_company_id: "cust-1",
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

        const invoices = rpcCalls[0].args.p_invoices as any[];
        let sawMeat = false;
        let sawFruits = false;
        for (const inv of invoices) {
          const lines = inv.products || inv.invoice_splitups || [];
          const ids = new Set(lines.map((l: any) => l.product_id));
          // Category purity is unaffected by this fix.
          const hasMeat = ids.has("M1") || ids.has("M2");
          const hasFruits = ids.has("F1") || ids.has("F2");
          expect(hasMeat && hasFruits).toBe(false);
          if (hasMeat) sawMeat = true;
          if (hasFruits) sawFruits = true;
        }
        // Both categories' products actually got a fair chance to appear
        // — the exact bug being fixed was Fruits (or Meat) ending up at
        // zero/near-zero real appearances despite a substantial
        // configured share.
        expect(sawMeat).toBe(true);
        expect(sawFruits).toBe(true);
      },
    );
  });
});
