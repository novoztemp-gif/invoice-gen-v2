import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Client-reported bug (extended to Sales) — major customer invoice_count
 * exceeding the batch's date range.
 *
 * Same root cause and fix as InvoiceEngine.majorCustomerDayLimit.test.ts,
 * applied to the Sales generation path
 * (generateInvoiceSplitupsInternal's own "Pre-generation Validation for
 * Sales Major Customers" loop) as defense in depth, mirroring the
 * Purchase-side "Rule 8" check. The client-side check in
 * useInvoiceForm.handleAddMajorCustomer already covers both Sales and
 * Purchase (shared hook, no batchType branching) — this test covers the
 * server-side generation-time backstop specifically for Sales.
 */

function makeMockSupabase(
  queues: Record<string, Array<{ data: any; error: any }>>,
) {
  const counters: Record<string, number> = {};
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
    rpc(_fnName: string, _args: any) {
      return Promise.resolve({ data: [], error: null });
    },
  };
  return { supabase: supabase as any };
}

describe("InvoiceEngine.generateAndSaveInvoices — Sales major customer day-limit defense in depth", () => {
  it("rejects Sales generation when a major customer's invoice_count exceeds the date range", async () => {
    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "SALES",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-01-30", // 30 days
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 2000,
      total_amount: 500000,
      products: [
        {
          product_id: "Chicken",
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
          amount: 300000,
          invoice_count: 35, // exceeds the 30-day range
          max_invoice_amount: 10000,
        },
      ],
      category_allocation: null,
      occurrence_semantics: null,
      stock_source_batch_id: "src-batch-1",
    };

    const { supabase } = makeMockSupabase({
      invoice_batch: [
        { data: batchRow, error: null },
        { data: null, error: null },
      ],
      issuing_companies: [
        { data: { abbreviation: "TST", company_name: "Test Co" }, error: null },
      ],
      daily_stock_ledger: [
        {
          data: [
            {
              ledger_date: "2026-01-01",
              product_id: "Chicken",
              opening_stock: 100000,
              purchased_quantity: 0,
              sold_quantity: 0,
            },
          ],
          error: null,
        },
      ],
      invoice: [{ data: [], error: null }],
    });

    await expect(
      InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1"),
    ).rejects.toThrow(/35 invoice\(s\)[\s\S]*30 day\(s\)/);
  });
});
