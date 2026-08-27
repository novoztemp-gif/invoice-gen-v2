import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Sprint 1.7P — tests for the quota-consumption connection between
 * ProductOccurrenceQuotaService and real generation
 * (selectProductsByOccurrence's new optional `occurrenceLedger` parameter,
 * and generateAndSaveInvoices' ledger-seeding step).
 */

function product(id: string, occurrencePercentage: number): any {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0000",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "10",
    perDayRateMax: "500",
    occurrencePercentage,
  };
}

describe("InvoiceEngine.selectProductsByOccurrence — ledger consumption (Sprint 1.7P)", () => {
  it("with no ledger argument: behavior is unchanged (legacy path) — selecting all candidates returns them all, untouched", () => {
    const products = [product("A", 50), product("B", 50)];
    const result = InvoiceEngine.selectProductsByOccurrence(products, 2);
    expect(result.map((p: any) => p.product_id).sort()).toEqual(["A", "B"]);
  });

  it("with a ledger: selecting all candidates (count >= pool size) decrements every selected product's remaining count", () => {
    const products = [product("A", 50), product("B", 50)];
    const ledger = new Map([
      ["A", 5],
      ["B", 3],
    ]);
    InvoiceEngine.selectProductsByOccurrence(products, 2, ledger);
    expect(ledger.get("A")).toBe(4);
    expect(ledger.get("B")).toBe(2);
  });

  it("without a ledger, the same call performs no decrement bookkeeping at all (nothing to decrement, no ledger passed)", () => {
    const products = [product("A", 50), product("B", 50)];
    // No ledger argument -> purely the legacy code path; nothing to assert
    // beyond "it still returns both products and does not throw."
    const result = InvoiceEngine.selectProductsByOccurrence(products, 2);
    expect(result.length).toBe(2);
  });

  it("ledger remaining count never goes below zero", () => {
    const products = [product("A", 100)];
    const ledger = new Map([["A", 0]]);
    InvoiceEngine.selectProductsByOccurrence(products, 1, ledger);
    expect(ledger.get("A")).toBe(0);
  });

  it("a product with remaining=0 in the ledger is picked far less often than one with remaining>0 (statistical, single-slot draw from a 2-product pool)", () => {
    const products = [product("A", 50), product("B", 50)];
    let bPicks = 0;
    const trials = 300;
    for (let i = 0; i < trials; i++) {
      // Fresh ledger each trial: A exhausted (weight floors to 0.01), B
      // still needs plenty (weight 50) — B should dominate the draw.
      const ledger = new Map([
        ["A", 0],
        ["B", 50],
      ]);
      const [picked] = InvoiceEngine.selectProductsByOccurrence(
        products,
        1,
        ledger,
      );
      if (picked.product_id === "B") bPicks++;
    }
    // With weights 0.01 vs 50, B should win the overwhelming majority —
    // a generous threshold (>80%) keeps this robust against normal
    // Math.random() variance while still proving the bias is real and
    // strongly directional, not coincidental.
    expect(bPicks / trials).toBeGreaterThan(0.8);
  });

  it("a product not present in the ledger falls back to its raw occurrencePercentage as weight (partial-ledger safety)", () => {
    const products = [product("A", 50), product("B", 50)];
    const ledger = new Map([["A", 10]]); // B intentionally absent
    const result = InvoiceEngine.selectProductsByOccurrence(products, 2, ledger);
    expect(result.length).toBe(2);
    // B was never in the ledger, so decrementing must not have touched it
    // or thrown.
    expect(ledger.has("B")).toBe(false);
  });
});

describe("InvoiceEngine.generateAndSaveInvoices — quota consumption end-to-end (Sprint 1.7P)", () => {
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

  it("GLOBAL: a multi-product batch still generates successfully and passes the Sprint 1.7N occurrence gate (quota bias active, no crash, no false rejection)", () => {
    const batchRow = {
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
          product_id: "A",
          product_name: "A",
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
        suppliers: [{ data: [{ id: "maj-a", category: "Meat" }], error: null }],
      },
      makeRpcHandler("TST-2026-27-P"),
    );

    return InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1").then(
      (count) => {
        expect(count).toBe(3);
        expect(rpcCalls.length).toBe(1);
      },
    );
  });

  it("CATEGORY: invalid category_allocation still prevents persistence exactly as before Sprint 1.7P (requirement 6, unaffected by quota consumption)", async () => {
    const batchRow = {
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
          product_id: "A",
          product_name: "A",
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
      category_allocation: { Meat: 40, Fruits: 40 }, // sums to 80, invalid
      occurrence_semantics: "CATEGORY",
    };

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
    ).rejects.toThrow(/Product Occurrence Configuration Invalid/);
    expect(rpcCalls.length).toBe(0);
  });
});
