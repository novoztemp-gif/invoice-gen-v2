import { describe, expect, it } from "vitest";
import {
  calendarMonthToFyIndex,
  formatFyLabel,
  InventorySummaryService,
} from "./InventorySummaryService";

// Mirrors the mock pattern already used in AnalyticsEngine.test.ts.
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

describe("formatFyLabel / calendarMonthToFyIndex", () => {
  it("formats a FY start year as the canonical 'YYYY-YY' label", () => {
    expect(formatFyLabel(2021)).toBe("2021-22");
    expect(formatFyLabel(2026)).toBe("2026-27");
  });

  it("maps calendar months to FY-relative index: April=1 .. March=12", () => {
    expect(calendarMonthToFyIndex(4)).toBe(1); // April
    expect(calendarMonthToFyIndex(12)).toBe(9); // December
    expect(calendarMonthToFyIndex(1)).toBe(10); // January
    expect(calendarMonthToFyIndex(3)).toBe(12); // March
  });
});

describe("InventorySummaryService.compute — day view (a specific FY month selected)", () => {
  it("computes carry-on/purchase/sold/leftover per day straight from the ledger, and splits money by invoice_batch_id's batch_type", async () => {
    const supabase = makeMockSupabase({
      daily_stock_ledger: [
        {
          product_id: "p1",
          ledger_date: "2026-08-01",
          opening_stock: 10,
          purchased_quantity: 5,
          sold_quantity: 3,
        },
      ],
      invoice_batch: [
        { id: "pb-1", batch_type: "PURCHASE" },
        { id: "sb-1", batch_type: "SALES" },
      ],
      invoice: [
        { invoice_batch_id: "pb-1", invoice_date: "2026-08-01", total_amount: 500 },
        { invoice_batch_id: "sb-1", invoice_date: "2026-08-01", total_amount: 900 },
      ],
    });

    // August 2026 falls inside FY 2026-27 (April 2026 - March 2027).
    const result = await InventorySummaryService.compute(supabase, {
      fyStartYear: 2026,
      fyMonthIndex: calendarMonthToFyIndex(8),
    });

    expect(result.granularity).toBe("day");
    expect(result.periodLabel).toBe("August 2026");
    const day1 = result.rows.find((r) => r.dateKey === "2026-08-01")!;
    expect(day1.carryOnStock).toBe(10);
    expect(day1.purchaseQty).toBe(5);
    expect(day1.soldQty).toBe(3);
    expect(day1.leftovers).toBe(12); // 10 + 5 - 3
    expect(day1.purchasePrice).toBe(500);
    expect(day1.soldPrice).toBe(900);
    expect(day1.grossProfit).toBe(400); // 900 - 500

    // A day with genuinely no ledger/invoice activity at all still gets a
    // row (the whole calendar month is always shown), all zeros.
    const day2 = result.rows.find((r) => r.dateKey === "2026-08-02")!;
    expect(day2.purchaseQty).toBe(0);
    expect(day2.soldQty).toBe(0);
    expect(day2.grossProfit).toBe(0);

    // Full month of August 2026.
    expect(result.rows.length).toBe(31);
  });

  it("REGRESSION — a later day's carry-on stock correctly nets out an earlier day's sales, never trusting a stale stored opening_stock", async () => {
    // Same class of bug fixed in SalesDayStockAvailability: day 2's stored
    // opening_stock (100) is stale noise. True carry-on for day 2 is day
    // 1's closing (10 + 5 purchased - 8 sold = 7).
    const supabase = makeMockSupabase({
      daily_stock_ledger: [
        {
          product_id: "p1",
          ledger_date: "2026-08-01",
          opening_stock: 10,
          purchased_quantity: 5,
          sold_quantity: 8,
        },
        {
          product_id: "p1",
          ledger_date: "2026-08-02",
          opening_stock: 100,
          purchased_quantity: 3,
          sold_quantity: 0,
        },
      ],
      invoice_batch: [],
      invoice: [],
    });

    const result = await InventorySummaryService.compute(supabase, {
      fyStartYear: 2026,
      fyMonthIndex: calendarMonthToFyIndex(8),
    });

    const day2 = result.rows.find((r) => r.dateKey === "2026-08-02")!;
    expect(day2.carryOnStock).toBe(7);
    expect(day2.leftovers).toBe(10); // 7 + 3 purchased, nothing sold
  });

  it("a month selected from EARLY in the FY (e.g. January, fyMonthIndex 10) resolves to the following calendar year", async () => {
    const supabase = makeMockSupabase({
      daily_stock_ledger: [],
      invoice_batch: [],
      invoice: [],
    });
    // FY 2026-27's January is calendar January 2027.
    const result = await InventorySummaryService.compute(supabase, {
      fyStartYear: 2026,
      fyMonthIndex: calendarMonthToFyIndex(1),
    });
    expect(result.periodLabel).toBe("January 2027");
    expect(result.rows[0].dateKey).toBe("2027-01-01");
  });
});

describe("InventorySummaryService.compute — year view (FY, no month selected)", () => {
  it("aggregates into one row per month IN FY ORDER (April first, March last), flows summed, carry-on = first active day, leftovers = last active day", async () => {
    const supabase = makeMockSupabase({
      daily_stock_ledger: [
        {
          product_id: "p1",
          ledger_date: "2026-04-05",
          opening_stock: 50,
          purchased_quantity: 10,
          sold_quantity: 5,
        },
        {
          product_id: "p1",
          ledger_date: "2026-04-20",
          opening_stock: 999, // stale — must be ignored, chained instead
          purchased_quantity: 20,
          sold_quantity: 15,
        },
      ],
      invoice_batch: [
        { id: "pb-1", batch_type: "PURCHASE" },
        { id: "sb-1", batch_type: "SALES" },
      ],
      invoice: [
        { invoice_batch_id: "pb-1", invoice_date: "2026-04-05", total_amount: 1000 },
        { invoice_batch_id: "pb-1", invoice_date: "2026-04-20", total_amount: 2000 },
        { invoice_batch_id: "sb-1", invoice_date: "2026-04-20", total_amount: 4000 },
      ],
    });

    const result = await InventorySummaryService.compute(supabase, {
      fyStartYear: 2026,
    });

    expect(result.granularity).toBe("month");
    expect(result.periodLabel).toBe("2026-27");
    expect(result.rows.length).toBe(12);
    // FY order: April 2026 first, March 2027 last.
    expect(result.rows[0].dateKey).toBe("2026-04");
    expect(result.rows[11].dateKey).toBe("2027-03");

    const april = result.rows[0];
    expect(april.carryOnStock).toBe(50);
    expect(april.purchaseQty).toBe(30);
    expect(april.soldQty).toBe(20);
    expect(april.purchasePrice).toBe(3000);
    expect(april.soldPrice).toBe(4000);
    expect(april.grossProfit).toBe(1000);
    // Leftovers = the LAST active day's (Apr 20) closing:
    // day1 closing = 50+10-5=55 (carry into day2); day2 = 55+20-15=60.
    expect(april.leftovers).toBe(60);

    // A month with zero activity still appears, all zeros.
    const may = result.rows.find((r) => r.dateKey === "2026-05")!;
    expect(may.purchaseQty).toBe(0);
    expect(may.carryOnStock).toBe(0);
  });

  it("a calendar date in Jan/Feb/March correctly belongs to the PREVIOUS year's FY", async () => {
    const supabase = makeMockSupabase({
      daily_stock_ledger: [
        {
          product_id: "p1",
          ledger_date: "2027-02-10",
          opening_stock: 5,
          purchased_quantity: 0,
          sold_quantity: 2,
        },
      ],
      invoice_batch: [],
      invoice: [],
    });

    // FY 2026-27 runs April 2026 - March 2027, so Feb 2027 belongs here.
    const result = await InventorySummaryService.compute(supabase, {
      fyStartYear: 2026,
    });
    const feb = result.rows.find((r) => r.dateKey === "2027-02")!;
    expect(feb.soldQty).toBe(2);

    // availableFyYears must report 2026 (the FY start year), not 2027.
    expect(result.availableFyYears).toContain(2026);
    expect(result.availableFyYears).not.toContain(2027);
  });

  it("availableFyYears always includes the requested FY start year even with no data for it", async () => {
    const supabase = makeMockSupabase({
      daily_stock_ledger: [],
      invoice_batch: [],
      invoice: [],
    });
    const result = await InventorySummaryService.compute(supabase, {
      fyStartYear: 2030,
    });
    expect(result.availableFyYears).toContain(2030);
  });
});
