import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Client-reported bug — major customer invoice_count exceeding the
 * batch's date range.
 *
 * A supplier/customer can only ever receive ONE invoice per day —
 * getSequentialDateForIndex (the sole date-assignment function for major
 * customer invoices) has no mechanism preventing more than one of a
 * major customer's own invoices from landing on the same day once
 * invoice_count exceeds the number of days in the batch's date range. On
 * a real batch, a major customer configured with invoice_count=35 across
 * a 30-day range silently produced two same-day, same-product invoices
 * for that customer — a violation of the "one bill per supplier per day"
 * business rule the client explicitly stated, with no error surfaced
 * anywhere until after the fact.
 *
 * Fix: both `validateBatchParams` (the pre-create config gate) and
 * `generatePurchaseInvoiceSplitupsInternal`'s own "Rule 8" pre-loop
 * validation (defense in depth) now reject a major customer whose
 * invoice_count exceeds the batch's numberOfDays, with a message
 * explaining the fix (reduce invoice count, raise the per-invoice max, or
 * widen the date range). A matching client-side check was also added to
 * useInvoiceForm's handleAddMajorCustomer for immediate feedback at
 * configuration time, before Generate is ever clicked.
 */

function product(id: string, occurrencePercentage: number) {
  return {
    product: {
      id,
      product_name: id,
      hsn_code: "0207",
      unit_of_measure: "kg",
    },
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "10",
    perDayRateMax: "500",
    occurrencePercentage,
  };
}

describe("InvoiceEngine.validateBatchParams — major customer day-limit check", () => {
  it("rejects a major customer whose invoice_count exceeds the batch's date range", () => {
    const result = InvoiceEngine.validateBatchParams({
      products: [product("P1", 100)],
      majorCustomers: [
        {
          customer_id: "maj-a",
          amount: 300000,
          invoice_count: 35,
          max_invoice_amount: 10000,
        } as any,
      ],
      invoiceDateFrom: "2026-01-01",
      invoiceDateTo: "2026-01-30", // 30 days
      minimumInvoiceAmount: 500,
      maximumInvoiceAmount: 2000,
      totalAmount: 500000,
    });

    expect(result.isValid).toBe(false);
    expect(result.message).toContain("35 invoice(s)");
    expect(result.message).toContain("30 day(s)");
  });

  it("allows a major customer whose invoice_count fits within the date range", () => {
    const result = InvoiceEngine.validateBatchParams({
      products: [product("P1", 100)],
      majorCustomers: [
        {
          customer_id: "maj-a",
          amount: 300000,
          invoice_count: 30,
          max_invoice_amount: 10000,
        } as any,
      ],
      invoiceDateFrom: "2026-01-01",
      invoiceDateTo: "2026-01-30", // 30 days
      minimumInvoiceAmount: 500,
      maximumInvoiceAmount: 2000,
      totalAmount: 500000,
    });

    expect(result.isValid).toBe(true);
  });
});

describe("InvoiceEngine.generateAndSaveInvoices — major customer day-limit defense in depth", () => {
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

  it("rejects generation when a major customer's invoice_count exceeds the date range, even if config validation was bypassed", async () => {
    const batchRow = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      batch_status: "draft",
      batch_type: "PURCHASE",
      invoice_date_from: "2026-01-01",
      invoice_date_to: "2026-01-30", // 30 days
      minimum_invoice_amount: 500,
      maximum_invoice_amount: 2000,
      total_amount: 500000,
      products: [
        {
          product_id: "P1",
          product_name: "P1",
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
    };

    const { supabase } = makeMockSupabase({
      invoice_batch: [
        { data: batchRow, error: null },
        { data: null, error: null },
      ],
      issuing_companies: [
        { data: { abbreviation: "TST", company_name: "Test Co" }, error: null },
      ],
      invoice: [{ data: [], error: null }],
      suppliers: [{ data: [{ id: "maj-a", category: "Meat" }], error: null }],
    });

    await expect(
      InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1"),
    ).rejects.toThrow(/35 invoice\(s\)[\s\S]*30 day\(s\)/);
  });
});
