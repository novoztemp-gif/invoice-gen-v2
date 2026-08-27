import { describe, expect, it } from "vitest";
import { AnalyticsEngine } from "./AnalyticsEngine";

/**
 * Real bugs fixed this session, each proven here by reproducing the exact
 * failure signature: filters that had zero effect, a field name that never
 * matched the real column, and a ledger that was never scoped to the
 * batches its own filter claimed to select.
 */

// A minimal, table-keyed Supabase mock. Every `.from(table)` returns a
// chainable builder that supports `.select()/.eq()/.order()` as no-ops and
// resolves (directly, or via `.range()` for fetchAllQueryRows callers) to
// `{ data: tableData[table], error: null }`. Good enough for these engines,
// which only ever do simple whole-table reads plus in-memory filtering.
function makeMockSupabase(tableData: Record<string, any[]>) {
  const builderFor = (table: string): any => {
    const rows = tableData[table] || [];
    const response = { data: rows, error: null };
    const builder: any = {};
    for (const m of ["select", "eq", "order", "in"]) {
      builder[m] = () => builder;
    }
    builder.range = () => Promise.resolve(response);
    builder.then = (onF: any, onR: any) =>
      Promise.resolve(response).then(onF, onR);
    return builder;
  };
  return { from: (table: string) => builderFor(table) } as any;
}

describe("AnalyticsEngine.getProfitLossMetrics — filter used to be a total no-op", () => {
  const batches = [
    {
      id: "sb-2025",
      batch_type: "SALES",
      financial_year: "2025-26",
      total_amount: 1000,
    },
    {
      id: "sb-2026",
      batch_type: "SALES",
      financial_year: "2026-27",
      total_amount: 5000,
    },
    {
      id: "pb-2025",
      batch_type: "PURCHASE",
      financial_year: "2025-26",
      invoice_date_from: "2025-05-01",
      total_amount: 400,
    },
    {
      id: "pb-2026",
      batch_type: "PURCHASE",
      financial_year: "2026-27",
      invoice_date_from: "2026-05-01",
      total_amount: 2000,
    },
  ];
  const invoices = [
    { invoice_batch_id: "sb-2025", invoice_date: "2025-06-01", total_amount: 1000 },
    { invoice_batch_id: "sb-2026", invoice_date: "2026-06-01", total_amount: 5000 },
  ];

  it("financialYear filter actually changes revenue/purchaseCost — previously identical for every filter value", async () => {
    const supabase = makeMockSupabase({
      invoice_batch: batches,
      invoice: invoices,
      expense_batch: [],
      expense_daily_ledger: [],
    });

    const all = await AnalyticsEngine.getProfitLossMetrics(supabase, {});
    const fy2025 = await AnalyticsEngine.getProfitLossMetrics(supabase, {
      financialYear: "2025-26",
    });
    const fy2026 = await AnalyticsEngine.getProfitLossMetrics(supabase, {
      financialYear: "2026-27",
    });

    // The whole point: these three must NOT be identical. Before the fix,
    // filter was never read, so all three landed on the same all-time
    // numbers.
    expect(fy2025.revenue).toBe(1000);
    expect(fy2025.purchaseCost).toBe(400);
    expect(fy2026.revenue).toBe(5000);
    expect(fy2026.purchaseCost).toBe(2000);
    expect(all.revenue).toBe(6000);
    expect(fy2025.revenue).not.toBe(all.revenue);
    expect(fy2026.revenue).not.toBe(fy2025.revenue);
  });
});

describe("AnalyticsEngine.getExpenseMetrics — field name and ledger scoping", () => {
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

  it("reads the real expense_category column, not the nonexistent `category` field", async () => {
    const supabase = makeMockSupabase({
      expense_batch: expBatches,
      expense_daily_ledger: ledger,
    });

    const metrics = await AnalyticsEngine.getExpenseMetrics(supabase, {});

    // Before the fix, `e.category` was always undefined, so every row
    // fell into "General Expense" regardless of its real category.
    const categories = metrics.categoryDistribution.map((c) => c.category);
    expect(categories).toContain("Fuel");
    expect(categories).toContain("Rent");
    expect(categories).not.toContain("General Expense");
  });

  it("scopes the ledger to the financial-year-filtered batches — previously used the unfiltered, all-time ledger regardless of the year selected", async () => {
    const supabase = makeMockSupabase({
      expense_batch: expBatches,
      expense_daily_ledger: ledger,
    });

    const all = await AnalyticsEngine.getExpenseMetrics(supabase, {});
    const fy2025 = await AnalyticsEngine.getExpenseMetrics(supabase, {
      financialYear: "2025-26",
    });

    expect(all.totalExpenses).toBe(1000);
    // Before the fix this would still be 1000 — the ledger was never
    // actually scoped to the filtered batch.
    expect(fy2025.totalExpenses).toBe(100);
    expect(fy2025.totalExpenses).not.toBe(all.totalExpenses);
  });
});
