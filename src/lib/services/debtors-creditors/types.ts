import {
  MonthlySplitUpMonth,
  MonthlySplitUpProduct,
  SplitUpMatrix,
} from "@/lib/services/monthly-splitup/types";

export type PartnerCategory = "Meat" | "Fruits";

export interface DebtorCreditorPerson {
  id: string;
  companyName: string;
  category: PartnerCategory;
}

export type ProductCategorySource =
  | "hsn-match"
  | "name-match"
  | "manual"
  | "unmatched";

export interface ResolvedSplitUpProduct extends MonthlySplitUpProduct {
  category: PartnerCategory | null;
  categorySource: ProductCategorySource;
}

/** Parsed from a re-uploaded Monthly Split-up *download* (3 sheets:
 * Uploaded Data / Purchase Split-up / Sales Split-up) — not the raw source
 * file Monthly Split-up itself consumes. */
export interface DebtorCreditorSourceData {
  financialYear: string;
  products: ResolvedSplitUpProduct[];
  /** Always 12, purchaseTotal always a resolved number (never null) — the
   * source file is itself Monthly Split-up's own output. */
  months: MonthlySplitUpMonth[];
  purchaseMatrix: SplitUpMatrix;
  salesMatrix: SplitUpMatrix;
}

export type SplitMode = "random" | "actual";

export interface PersonAmountEntry {
  personId: string;
  locked: boolean;
  amount: number;
}

export interface StockAllocationLine {
  personId: string;
  monthIndex: number;
  monthLabel: string;
  /** Positional index into the SAME source file's products[] this line's
   * role drew from — not comparable across the debtor and creditor files. */
  productIndex: number;
  hsnCode: string;
  description: string;
  qty: number;
  amount: number;
}

export interface StockAllocationShortfall {
  personId: string;
  personName: string;
  monthIndex: number;
  monthLabel: string;
  category: PartnerCategory;
  requiredAmount: number;
  allocatedAmount: number;
  shortfallAmount: number;
}

export interface StockAllocationRunResult {
  ok: boolean;
  lines: StockAllocationLine[];
  shortfalls: StockAllocationShortfall[];
}

export interface DebtorCreditorRoleResult {
  source: DebtorCreditorSourceData;
  selectedMonthIndices: number[];
  totalAmount: number;
  personAmounts: PersonAmountEntry[];
  allocation: StockAllocationRunResult;
}

export interface PersonKnockoffSummary {
  personId: string;
  companyName: string;
  category: PartnerCategory;
  debtorTotal: number;
  creditorTotal: number;
  knockoff: number;
}
