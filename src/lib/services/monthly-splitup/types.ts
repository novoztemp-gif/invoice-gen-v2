// Shared shapes for the Monthly Split-up report. One source of truth used
// by the parser, the allocation engine, both API routes, and the UI — the
// same MonthlySplitUpResult that /generate returns is exactly what the
// client holds in state and posts back to /download, so nothing here is
// re-derived twice.

export interface MonthlySplitUpProduct {
  hsnCode: string;
  description: string;
  uqc: string;
  /** Annual total quantity (whole units, e.g. KGS) — shared by purchase and sales. */
  totalQuantity: number;
  /** Annual taxable (sold) value in rupees. */
  taxableValue: number;
}

export interface MonthlySplitUpMonth {
  /** e.g. "Apr-24" */
  label: string;
  /** 0 = first month of the financial year (April), 11 = last (March). */
  monthIndex: number;
  /** All-products total purchase amount for this month. Null until resolved. */
  purchaseTotal: number | null;
  /** All-products total sales amount for this month. Always given. */
  salesTotal: number;
}

export interface MonthlySplitUpAnnualTotals {
  totalQuantity: number;
  taxableValue: number;
  purchaseTotal: number;
  salesTotal: number;
  grossProfit: number;
}

export interface MonthlySplitUpParsedInput {
  /** e.g. "2024-25", read verbatim from cell A1. */
  financialYear: string;
  products: MonthlySplitUpProduct[];
  /** Always exactly 12 entries, monthIndex 0..11. */
  months: MonthlySplitUpMonth[];
  totals: MonthlySplitUpAnnualTotals;
}

export interface SplitUpCell {
  qty: number;
  amount: number;
}

/** Positional matrix: matrix[productIndex][monthIndex]. Not keyed by HSN —
 * HSN codes are not guaranteed unique across product rows in a real GST9
 * upload; `products`/`months` order is the stable key instead. */
export type SplitUpMatrix = SplitUpCell[][];

export interface MonthlySplitUpResult {
  financialYear: string;
  products: MonthlySplitUpProduct[];
  /** purchaseTotal is always resolved (non-null) by the time this is built. */
  months: MonthlySplitUpMonth[];
  purchaseMatrix: SplitUpMatrix;
  salesMatrix: SplitUpMatrix;
  /** True when one or more months had no purchase figure in the upload and
   * the assumed margin % was used to synthesize it. */
  purchaseTotalsWereSynthesized: boolean;
  /** The margin % actually used wherever synthesis occurred (for display). */
  purchaseMarginPercentUsed: number;
}
