import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import {
  computeDailyChronologicalStock,
  StockLedgerRow,
} from "@/lib/services/StockCalculationService";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface InventorySummaryRow {
  dateKey: string;
  dateLabel: string;
  carryOnStock: number;
  purchaseQty: number;
  soldQty: number;
  purchasePrice: number;
  soldPrice: number;
  leftovers: number;
  grossProfit: number;
}

export interface InventorySummaryResult {
  granularity: "month" | "day";
  periodLabel: string;
  rows: InventorySummaryRow[];
  /** Financial-year START years (e.g. 2026 means FY "2026-27"). */
  availableFyYears: number[];
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function formatFyLabel(fyStartYear: number): string {
  return `${fyStartYear}-${String(fyStartYear + 1).slice(-2)}`;
}

/**
 * Financial year runs April -> March (confirmed with the user). `fyIndex`
 * 1..9 = April..December of `fyStartYear`; 10..12 = January..March of
 * `fyStartYear + 1`.
 */
export function fyIndexToCalendarMonth(
  fyStartYear: number,
  fyIndex: number,
): { year: number; month: number } {
  if (fyIndex <= 9) {
    return { year: fyStartYear, month: fyIndex + 3 };
  }
  return { year: fyStartYear + 1, month: fyIndex - 9 };
}

/** The FY start year a calendar (year, month) falls inside — April..Dec belongs to that year's FY, Jan..March belongs to the PREVIOUS year's FY. */
function calendarMonthToFyStartYear(year: number, month: number): number {
  return month >= 4 ? year : year - 1;
}

/** FY-relative index (1=April..12=March) for a calendar month. */
export function calendarMonthToFyIndex(month: number): number {
  return month >= 4 ? month - 3 : month + 9;
}

/**
 * Powers the Inventory Management page's month/year summary panel. One row
 * per month (year view) or one row per day (month view), each with:
 * Date | Carry-on Stock | Purchase Qty | Sold Qty | Purchase Price |
 * Sold Price | Leftovers | Gross Profit.
 *
 * "Year" here means a FINANCIAL year, April -> March (e.g. FY 2026-27 =
 * April 2026 through March 2027) — confirmed with the user, matching the
 * FY label format ("2026-27") already used everywhere else in the app for
 * invoice numbering, not a Jan-Dec calendar year.
 *
 * Carry-on Stock/Leftovers deliberately go through
 * StockCalculationService's chronological recurrence (opening(day) =
 * closing(day-1)) rather than summing the stored `opening_stock` column
 * directly — the same fix applied to SalesDayStockAvailability after a
 * real production bug: the stored column is only trustworthy for a
 * ledger's very first row.
 *
 * Gross Profit mirrors AnalyticsEngine.getProfitLossMetrics' own
 * definition exactly (period Sales revenue minus period Purchase cost,
 * not a FIFO-matched COGS), just computed per calendar day instead of per
 * financial year, so a month/year row's Gross Profit always agrees with
 * what the existing Profit & Loss report would show for that same window.
 */
export class InventorySummaryService {
  public static async compute(
    supabase: SupabaseClient,
    params: { fyStartYear: number; fyMonthIndex?: number },
  ): Promise<InventorySummaryResult> {
    const { fyStartYear, fyMonthIndex } = params;

    const [ledgerRows, batchesRes, invoiceRows] = await Promise.all([
      fetchAllQueryRows((from, to) =>
        supabase
          .from("daily_stock_ledger")
          .select(
            "product_id, ledger_date, opening_stock, purchased_quantity, sold_quantity",
          )
          .order("ledger_date", { ascending: true })
          .range(from, to),
      ),
      supabase.from("invoice_batch").select("id, batch_type"),
      fetchAllQueryRows((from, to) =>
        supabase
          .from("invoice")
          .select("invoice_batch_id, invoice_date, total_amount")
          .range(from, to),
      ),
    ]);
    if (batchesRes.error) throw batchesRes.error;

    const batchTypeById = new Map<string, string>(
      (batchesRes.data || []).map((b: any) => [b.id, b.batch_type]),
    );

    const dailyStock = computeDailyChronologicalStock(
      (ledgerRows || []) as StockLedgerRow[],
    );

    const dailyQty = new Map<
      string,
      { carryOn: number; purchased: number; sold: number; leftover: number }
    >();
    for (const day of dailyStock) {
      const entry = dailyQty.get(day.ledger_date) || {
        carryOn: 0,
        purchased: 0,
        sold: 0,
        leftover: 0,
      };
      entry.carryOn += day.opening;
      entry.purchased += day.purchased;
      entry.sold += day.sold;
      entry.leftover += day.closing;
      dailyQty.set(day.ledger_date, entry);
    }

    const dailyMoney = new Map<
      string,
      { purchasePrice: number; soldPrice: number }
    >();
    for (const inv of invoiceRows || []) {
      const date = (inv as any).invoice_date;
      if (!date) continue;
      const type = batchTypeById.get((inv as any).invoice_batch_id);
      const entry = dailyMoney.get(date) || {
        purchasePrice: 0,
        soldPrice: 0,
      };
      const amount = Number((inv as any).total_amount || 0);
      if (type === "PURCHASE") {
        entry.purchasePrice += amount;
      } else if (type === "SALES") {
        entry.soldPrice += amount;
      }
      dailyMoney.set(date, entry);
    }

    const allDateKeys = new Set<string>([
      ...dailyQty.keys(),
      ...dailyMoney.keys(),
    ]);
    const availableFyYears = Array.from(
      new Set(
        Array.from(allDateKeys)
          .map((d) => {
            const y = parseInt(d.slice(0, 4), 10);
            const m = parseInt(d.slice(5, 7), 10);
            return Number.isFinite(y) && Number.isFinite(m)
              ? calendarMonthToFyStartYear(y, m)
              : NaN;
          })
          .filter((y) => Number.isFinite(y)),
      ),
    ).sort((a, b) => b - a);
    if (!availableFyYears.includes(fyStartYear)) {
      availableFyYears.unshift(fyStartYear);
      availableFyYears.sort((a, b) => b - a);
    }

    const buildRow = (
      dateKey: string,
      dateLabel: string,
    ): InventorySummaryRow => {
      const qty = dailyQty.get(dateKey) || {
        carryOn: 0,
        purchased: 0,
        sold: 0,
        leftover: 0,
      };
      const money = dailyMoney.get(dateKey) || {
        purchasePrice: 0,
        soldPrice: 0,
      };
      return {
        dateKey,
        dateLabel,
        carryOnStock: round2(qty.carryOn),
        purchaseQty: round2(qty.purchased),
        soldQty: round2(qty.sold),
        purchasePrice: round2(money.purchasePrice),
        soldPrice: round2(money.soldPrice),
        leftovers: round2(qty.leftover),
        grossProfit: round2(money.soldPrice - money.purchasePrice),
      };
    };

    if (fyMonthIndex) {
      const { year, month } = fyIndexToCalendarMonth(fyStartYear, fyMonthIndex);
      const numDays = daysInMonth(year, month);
      const rows: InventorySummaryRow[] = [];
      for (let d = 1; d <= numDays; d++) {
        const dateKey = `${year}-${pad2(month)}-${pad2(d)}`;
        rows.push(
          buildRow(dateKey, `${pad2(d)} ${MONTH_NAMES[month - 1]} ${year}`),
        );
      }
      return {
        granularity: "day",
        periodLabel: `${MONTH_NAMES[month - 1]} ${year}`,
        rows,
        availableFyYears,
      };
    }

    const rows: InventorySummaryRow[] = [];
    for (let fyIdx = 1; fyIdx <= 12; fyIdx++) {
      const { year, month } = fyIndexToCalendarMonth(fyStartYear, fyIdx);
      const numDays = daysInMonth(year, month);
      let carryOn = 0;
      let purchased = 0;
      let sold = 0;
      let purchasePrice = 0;
      let soldPrice = 0;
      let leftover = 0;
      let firstDaySeen = false;
      for (let d = 1; d <= numDays; d++) {
        const dateKey = `${year}-${pad2(month)}-${pad2(d)}`;
        const qty = dailyQty.get(dateKey);
        const money = dailyMoney.get(dateKey);
        if (qty) {
          if (!firstDaySeen) {
            carryOn = qty.carryOn;
            firstDaySeen = true;
          }
          purchased += qty.purchased;
          sold += qty.sold;
          leftover = qty.leftover;
        }
        if (money) {
          purchasePrice += money.purchasePrice;
          soldPrice += money.soldPrice;
        }
      }
      rows.push({
        dateKey: `${year}-${pad2(month)}`,
        dateLabel: `${MONTH_NAMES[month - 1]} ${year}`,
        carryOnStock: round2(carryOn),
        purchaseQty: round2(purchased),
        soldQty: round2(sold),
        purchasePrice: round2(purchasePrice),
        soldPrice: round2(soldPrice),
        leftovers: round2(leftover),
        grossProfit: round2(soldPrice - purchasePrice),
      });
    }

    return {
      granularity: "month",
      periodLabel: formatFyLabel(fyStartYear),
      rows,
      availableFyYears,
    };
  }
}
