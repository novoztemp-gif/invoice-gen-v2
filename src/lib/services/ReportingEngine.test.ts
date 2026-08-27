import { describe, expect, it } from "vitest";
import { ReportingEngine } from "./ReportingEngine";

/**
 * Real bugs fixed this session: a database-level filter that silently
 * dropped NULL-batch_type Sales invoices, and a report that filtered on a
 * column that doesn't exist on its own table.
 */

function makeMockSupabase(tableData: Record<string, any[]>) {
  const builderFor = (table: string): any => {
    const rows = tableData[table] || [];
    const response = { data: rows, error: null };
    const builder: any = {};
    for (const m of ["select", "eq", "neq", "order", "in"]) {
      builder[m] = () => builder;
    }
    builder.range = () => Promise.resolve(response);
    builder.then = (onF: any, onR: any) =>
      Promise.resolve(response).then(onF, onR);
    return builder;
  };
  return { from: (table: string) => builderFor(table) } as any;
}

describe("ReportingEngine.getSalesReports — null batch_type invoices", () => {
  it("includes an invoice whose batch has a null/blank batch_type — previously dropped by a SQL .neq() NULL-semantics bug", async () => {
    const invoices = [
      {
        id: "inv-1",
        invoice_number: "S-001",
        invoice_date: "2026-01-01",
        total_amount: 500,
        products: [{ customer_name: "Acme" }],
        invoice_batch: {
          id: "b1",
          batch_number: "B1",
          batch_type: "SALES",
          financial_year: "2026-27",
        },
      },
      {
        id: "inv-2",
        invoice_number: "S-002",
        invoice_date: "2026-01-02",
        total_amount: 700,
        products: [{ customer_name: "Beta" }],
        // Legacy/default row -- batch_type never explicitly set.
        invoice_batch: {
          id: "b2",
          batch_number: "B2",
          batch_type: null,
          financial_year: "2026-27",
        },
      },
      {
        id: "inv-3",
        invoice_number: "P-001",
        invoice_date: "2026-01-03",
        total_amount: 999,
        products: [{ customer_name: "Gamma" }],
        invoice_batch: {
          id: "b3",
          batch_number: "B3",
          batch_type: "PURCHASE",
          financial_year: "2026-27",
        },
      },
    ];
    const supabase = makeMockSupabase({ invoice_batch: [], invoice: invoices });

    const report = await ReportingEngine.getSalesReports(supabase, {});
    const invoiceNumbers = report.registerRows.map((r) => r.invoice_number);

    // The null-batch_type Sales invoice must be included...
    expect(invoiceNumbers).toContain("S-001");
    expect(invoiceNumbers).toContain("S-002");
    // ...and the real Purchase invoice must still be excluded.
    expect(invoiceNumbers).not.toContain("P-001");
  });
});

describe("ReportingEngine.getExpenditureReports — nonexistent column", () => {
  it("scopes the register by the batch's own financial_year instead of a financial_year column the ledger table doesn't have", async () => {
    const expBatches = [
      { id: "eb-2025", financial_year: "2025-26" },
      { id: "eb-2026", financial_year: "2026-27" },
    ];
    const ledger = [
      {
        expense_batch_id: "eb-2025",
        expense_category: "Fuel",
        expense_date: "2025-05-01",
        amount: 100,
      },
      {
        expense_batch_id: "eb-2026",
        expense_category: "Rent",
        expense_date: "2026-05-01",
        amount: 900,
      },
    ];
    const supabase = makeMockSupabase({
      expense_batch: expBatches,
      expense_daily_ledger: ledger,
    });

    // Before the fix, this threw/returned nothing usable because
    // `.eq("financial_year", ...)` referenced a column that doesn't
    // exist on expense_daily_ledger — the register silently went empty
    // while the summary (from getExpenseMetrics) kept showing real
    // totals. It must resolve, and it must actually filter correctly.
    const report = await ReportingEngine.getExpenditureReports(supabase, {
      financialYear: "2025-26",
    });

    expect(report.registerRows.length).toBe(1);
    expect(report.registerRows[0].expense_batch_id).toBe("eb-2025");
  });
});
