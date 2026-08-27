import { describe, expect, it } from "vitest";
import { SalesInvoiceValidator } from "./SalesInvoiceValidator";

/**
 * Real, reported bug: a pre-existing invoice line's stored `amount` didn't
 * match its own quantity x rate (e.g. a stray non-whole-rupee value like
 * 2344.5) — undetected for as long as no edit happened to touch that exact
 * invoice, since nothing previously self-healed it. SalesDayScopedEditEngine's
 * same-day redistribution validates a wider set of invoices per edit than
 * before, which is what actually surfaced it: a completely unrelated edit
 * (adding 10kg of a different product on a different invoice) got blocked
 * with "Line Amount Mismatch" / "Batch Total Mismatch" errors that had
 * nothing to do with what the user changed.
 */
function makeMockSupabase(tableData: Record<string, any[]>) {
  const builderFor = (table: string): any => {
    const rows = tableData[table] || [];
    const response = { data: rows, error: null };
    const singleResponse = { data: rows[0] || null, error: null };
    const builder: any = {};
    for (const m of ["select", "eq", "order", "in"]) {
      builder[m] = () => builder;
    }
    builder.single = () => Promise.resolve(singleResponse);
    builder.maybeSingle = () => Promise.resolve(singleResponse);
    builder.range = () => Promise.resolve(response);
    builder.then = (onF: any, onR: any) =>
      Promise.resolve(response).then(onF, onR);
    return builder;
  };
  return { from: (table: string) => builderFor(table) } as any;
}

describe("SalesInvoiceValidator.loadContext — self-heals stale line amounts", () => {
  it("recomputes a line's amount from its own quantity x rate when the stored value doesn't match, and recomputes the invoice total to match", async () => {
    const supabase = makeMockSupabase({
      invoice_batch: [
        {
          id: "batch-1",
          batch_type: "SALES",
          batch_status: "GENERATED",
          total_amount: 71558.5,
          stock_source_batch_id: null,
          major_customers: [],
          minimum_invoice_amount: 0,
          maximum_invoice_amount: 0,
        },
      ],
      invoice: [
        {
          id: "inv-1",
          invoice_batch_id: "batch-1",
          invoice_number: "AT-2026-27-S-0000001",
          invoice_date: "2026-08-01",
          total_amount: 5344.5,
          products: [
            {
              product_id: "onion-id",
              product_name: "ONIONS",
              hsn_code: "0703",
              unit_of_measure: "kg",
              category: "Fruits",
              // Stale — doesn't match 31.26 x 75 = 2344.5... actually
              // simulate the real report: quantity/rate are clean, amount
              // is the one stray non-whole value.
              quantity: 23.25,
              rate: 100,
              amount: 2344.5,
            },
            {
              product_id: "yam-id",
              product_name: "YAMS",
              hsn_code: "0714",
              unit_of_measure: "kg",
              category: "Fruits",
              quantity: 30,
              rate: 100,
              amount: 3000,
            },
          ],
        },
      ],
      product_rules: [],
      products: [],
    });

    const context = await SalesInvoiceValidator.loadContext(
      supabase,
      "batch-1",
    );

    const inv = context.invoices.find((i) => i.id === "inv-1")!;
    const onionLine = inv.products.find((p) => p.product_id === "onion-id")!;
    expect(onionLine.amount).toBe(2325); // computeLineAmount(23.25, 100)
    expect(inv.total_amount).toBe(5325); // 2325 + 3000, recomputed from lines
  });

  it("leaves an already-consistent invoice completely untouched", async () => {
    const supabase = makeMockSupabase({
      invoice_batch: [
        {
          id: "batch-1",
          batch_type: "SALES",
          batch_status: "GENERATED",
          total_amount: 3000,
          stock_source_batch_id: null,
          major_customers: [],
          minimum_invoice_amount: 0,
          maximum_invoice_amount: 0,
        },
      ],
      invoice: [
        {
          id: "inv-1",
          invoice_batch_id: "batch-1",
          invoice_number: "AT-2026-27-S-0000001",
          invoice_date: "2026-08-01",
          total_amount: 3000,
          products: [
            {
              product_id: "yam-id",
              product_name: "YAMS",
              hsn_code: "0714",
              unit_of_measure: "kg",
              category: "Fruits",
              quantity: 30,
              rate: 100,
              amount: 3000,
            },
          ],
        },
      ],
      product_rules: [],
      products: [],
    });

    const context = await SalesInvoiceValidator.loadContext(
      supabase,
      "batch-1",
    );

    const inv = context.invoices.find((i) => i.id === "inv-1")!;
    expect(inv.products[0].amount).toBe(3000);
    expect(inv.total_amount).toBe(3000);
  });
});
