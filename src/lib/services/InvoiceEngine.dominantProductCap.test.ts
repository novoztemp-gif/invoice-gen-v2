import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * URGENT REGRESSION FIX — GLOBAL semantics, per-invoice occurrence cap.
 *
 * Root cause (confirmed against the real 1011-invoice production batch's
 * own dev-server log, after the category-avg-lines fix in
 * InvoiceEngine.categoryLinesMismatch.test.ts): a product can occur AT
 * MOST ONCE per invoice — an invoice never carries two lines of the same
 * product — so no single product's occurrence target can ever legitimately
 * exceed its own category's invoice count, no matter how large its
 * percentage share is. `computeCategoryCapacityAwareTargets` converts a
 * category's percentage shares into a SLOT-count target (invoice count x
 * that category's own avg lines/invoice) and apportions it directly —
 * which silently violates that ceiling whenever a product's own
 * within-category share, applied to an avgLinesForCat > 1, implies more
 * occurrences than there are invoices to carry them. Confirmed exactly on
 * the real batch: a product with a slot-based target of 314 could only
 * ever be placed on its own category's ~192 real invoices — a
 * mathematically impossible target that no amount of selection bias or
 * retrying could ever close, while the "missing" budget spilled out as
 * scattered, unrelated overshoot on other same-category products (visible
 * in the real log as several unrelated products all landing ~+11 over
 * target at once).
 *
 * Fix: `apportionCategoryTargetsWithPerInvoiceCap` caps any product whose
 * raw apportioned target exceeds its category's own invoice count at
 * exactly that count, then redistributes the freed slot budget across the
 * category's remaining (uncapped) products — reusing the same, unmodified
 * `calculateTargetOccurrences` apportionment each pass. No stored
 * percentage, and no apportionment algorithm, was touched — only the
 * ceiling now enforced on what comes out of it.
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

describe("InvoiceEngine.generateAndSaveInvoices — GLOBAL dominant-product per-invoice cap fix", () => {
  it("a product whose slot-based share would exceed its own category's invoice count still passes the gate", () => {
    const products = [
      product("M1", 60, "Meat"), // dominant within a small Meat category
      product("M2", 5, "Meat"),
      product("F1", 15, "Fruits"),
      product("F2", 10, "Fruits"),
      product("F3", 10, "Fruits"),
    ];

    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "PURCHASE",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-03-15",
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 2000,
      total_amount: 300000,
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
        expect(count).toBeGreaterThan(0);
        expect(rpcCalls.length).toBe(1); // gate passed, persistence reached
      },
    );
  });
});
