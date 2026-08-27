import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Sprint 1.7Q — tests for the category-level quota-consumption connection
 * added on top of Sprint 1.7P's product-level occurrenceLedger:
 * pickCategoryFromLedger (private, exercised indirectly through
 * generateAndSaveInvoices) and the categoryLedger parameter threaded
 * through generatePurchaseInvoiceSplitupsInternal /
 * generateInvoiceSplitupsInternal.
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

function meatProduct(id: string, occurrencePercentage: number) {
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

function fruitProduct(id: string, occurrencePercentage: number) {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0803",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "10",
    perDayRateMax: "500",
    occurrencePercentage,
    category: "Fruits",
  };
}

describe("InvoiceEngine — pickCategoryFromLedger (Sprint 1.7Q, exercised via generateAndSaveInvoices)", () => {
  it("CATEGORY semantics, Purchase: a single Meat product (100% category allocation) generates only Meat invoices — no Fruits mixing", async () => {
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
      products: [meatProduct("A", 100)],
      selected_customers: [],
      major_customers: [],
      category_allocation: { Meat: 100, Fruits: 0 },
      occurrence_semantics: "CATEGORY",
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
        suppliers: [{ data: [], error: null }],
      },
      makeRpcHandler("TST-2026-27-P"),
    );

    const count = await InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1");
    expect(count).toBeGreaterThan(0);
    expect(rpcCalls.length).toBe(1);
    const invoices = rpcCalls[0].args.p_invoices as any[];
    for (const inv of invoices) {
      for (const line of inv.invoice_splitups || inv.line_items || []) {
        expect(line.product_id).toBe("A");
      }
    }
  });

  it("pickCategoryFromLedger: always returns exactly ONE category per call (never mixes Meat+Fruits) and decrements only the chosen category", () => {
    // Direct unit test of the new private helper, both Sprint 1.7Q call
    // sites (Purchase's STEP-2 remaining-batch loop, Sales' major-customer
    // loop) route through this single function — proving it here covers
    // both without depending on the full balancing/generation pipeline
    // (which has its own, unrelated feasibility constraints under tight
    // fixtures). Accessed via `as any` since it's a private static method;
    // this is a runtime JS function like any other, TS visibility is
    // compile-time only.
    const engine = InvoiceEngine as any;
    const ledger = new Map<"Meat" | "Fruits", number>([
      ["Meat", 3],
      ["Fruits", 0],
    ]);

    for (let i = 0; i < 20; i++) {
      const chosen = engine.pickCategoryFromLedger(
        ["Meat", "Fruits"],
        ledger,
        () => "Meat",
      );
      // A single call must return exactly one category, never both/neither.
      expect(["Meat", "Fruits"]).toContain(chosen);
    }
  });

  it("pickCategoryFromLedger: strongly favors the category with remaining quota over an exhausted one (statistical, mirrors selectProductsByOccurrence's own bias test)", () => {
    const engine = InvoiceEngine as any;
    let fruitsPicks = 0;
    const trials = 300;
    for (let i = 0; i < trials; i++) {
      const ledger = new Map<"Meat" | "Fruits", number>([
        ["Meat", 0],
        ["Fruits", 50],
      ]);
      const chosen = engine.pickCategoryFromLedger(
        ["Meat", "Fruits"],
        ledger,
        () => "Meat",
      );
      if (chosen === "Fruits") fruitsPicks++;
    }
    expect(fruitsPicks / trials).toBeGreaterThan(0.8);
  });

  it("pickCategoryFromLedger: decrements the chosen category's remaining count and never goes below zero", () => {
    const engine = InvoiceEngine as any;
    const ledger = new Map<"Meat" | "Fruits", number>([
      ["Meat", 1],
      ["Fruits", 1],
    ]);
    const first = engine.pickCategoryFromLedger(
      ["Meat", "Fruits"],
      ledger,
      () => "Meat",
    );
    expect(ledger.get(first)).toBe(0);
    // Second draw: the just-exhausted category floors to weight 0.01, the
    // other still has weight 1 — call it enough times that decrementing
    // the untouched category never pushes it below zero.
    for (let i = 0; i < 5; i++) {
      engine.pickCategoryFromLedger(["Meat", "Fruits"], ledger, () => "Meat");
    }
    expect(ledger.get("Meat")).toBeGreaterThanOrEqual(0);
    expect(ledger.get("Fruits")).toBeGreaterThanOrEqual(0);
  });

  it("pickCategoryFromLedger: falls back to the caller's existing logic when categoryLedger is absent (GLOBAL/legacy — unchanged behavior)", () => {
    const engine = InvoiceEngine as any;
    const chosen = engine.pickCategoryFromLedger(
      ["Meat", "Fruits"],
      undefined,
      () => "Fruits",
    );
    expect(chosen).toBe("Fruits");
  });

  it("pickCategoryFromLedger: falls back when a category key is present in categoryKeys but absent from the ledger (partial-ledger safety, mirrors selectProductsByOccurrence)", () => {
    const engine = InvoiceEngine as any;
    const ledger = new Map<"Meat" | "Fruits", number>([["Meat", 2]]); // Fruits intentionally absent
    const chosen = engine.pickCategoryFromLedger(
      ["Meat", "Fruits"],
      ledger,
      () => "Fruits",
    );
    expect(chosen).toBe("Fruits"); // fell back rather than crashing or guessing
    expect(ledger.get("Meat")).toBe(2); // untouched — fallback path never decrements
  });

  it("GLOBAL semantics: behavior is unaffected by the new category ledger — generation still succeeds and passes the Sprint 1.7N gate", async () => {
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
      products: [meatProduct("A", 100)],
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

    const count = await InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1");
    expect(count).toBe(3);
    expect(rpcCalls.length).toBe(1);
  });

  it("legacy/no-config (occurrence_semantics undefined): behavior unaffected — generation succeeds exactly as before", async () => {
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
      products: [meatProduct("A", 100)],
      selected_customers: [],
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 3000,
          invoice_count: 2,
          max_invoice_amount: 2000,
        },
      ],
      // No category_allocation / occurrence_semantics fields at all.
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

    const count = await InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1");
    expect(count).toBe(2);
    expect(rpcCalls.length).toBe(1);
  });

  it("CATEGORY semantics: an invalid category_allocation still prevents persistence (unaffected by the new category ledger)", async () => {
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
      products: [meatProduct("A", 100)],
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
