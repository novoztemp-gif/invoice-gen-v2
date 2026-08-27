export const BALANCE_LIMITS = {
  maxInvoiceLines: 8,
  maxQuantityCandidates: 12,
  maxRateCandidates: 5,
  maxLineCandidates: 24,
  maxInvoiceCandidates: 16,
  maxSolverStates: 20_000,
  residualInvoiceCount: 3,
  maxResidualCombinations: 4_096,
  plannerTimeMs: 8_000,
} as const;

export const BALANCE_COST = {
  changedInvoice: 100,
  changedLine: 20,
  quantityStep: 10,
  rateRupee: 2,
  quantityBoundary: 25,
  rateBoundary: 25,
} as const;

export const MONEY_TOLERANCE = 0.001;

export type PurchaseLine = {
  product_id: string;
  product_name?: string;
  hsn_code?: string;
  unit_of_measure?: string;
  category?: string;
  quantity: number;
  rate: number;
  amount: number;
};

export type PurchaseInvoice = {
  id: string;
  invoice_batch_id: string;
  invoice_number: string;
  invoice_date: string;
  products: PurchaseLine[];
  total_amount: number;
  transport_mode?: string | null;
  vehicle_number?: string | null;
  date_of_supply?: string | null;
};

export type PurchaseInvoiceUpdate = Pick<
  PurchaseInvoice,
  | "products"
  | "total_amount"
  | "transport_mode"
  | "vehicle_number"
  | "date_of_supply"
>;

export type ProductConstraint = {
  productId: string;
  category: string;
  unitOfMeasure: string;
  quantityMin: number;
  quantityMax: number;
  rateMin: number;
  rateMax: number;
  hsnCode?: string;
  productName?: string;
};

export type PurchaseBalanceContext = {
  batchId: string;
  /**
   * The EFFECTIVE target total — invoice_batch.total_amount as stored,
   * PLUS the net effect of any header-total self-heal corrections applied
   * to `invoices` (see PurchaseInvoiceValidator.selfHealHeaderTotals).
   * Never the raw stored value alone: if even one invoice's stale header
   * total got corrected, the raw stored value no longer matches what
   * `invoices` actually sums to, and every consumer of this field (the
   * money solver's target, FinalValidator's expected-total check) needs
   * the number that's actually consistent with the invoices it's about
   * to work with.
   */
  batchTotal: number;
  supplierCategory: string;
  invoices: PurchaseInvoice[];
  constraints: Map<string, ProductConstraint>;
  majorCustomerIds: Set<string>;
  /** invoice_batch.minimum_invoice_amount / maximum_invoice_amount — null/undefined means no configured limit (Sprint 1.5A). */
  thresholdMin: number | null;
  thresholdMax: number | null;
  /**
   * Invoices whose stored total_amount didn't match the sum of their own
   * (individually already-correct) lines, self-healed at load time — see
   * PurchaseInvoiceValidator.selfHealHeaderTotals. Keyed by invoice id;
   * empty when nothing needed correcting. AutoBalanceEngine merges these
   * into the persisted batch so the correction actually gets written back,
   * not just papered over in-memory for this one operation.
   */
  headerTotalCorrections: Map<string, PurchaseInvoice>;
};

/**
 * (Sprint 1.5A) The ONE authoritative implementation of the Purchase
 * invoice amount range rule — every caller that needs to check
 * `minimum_invoice_amount <= total <= maximum_invoice_amount` must call
 * this rather than reimplementing the comparison, so the rule (and its
 * rounding/tolerance behavior) can never drift between call sites.
 *
 * A missing/non-positive min or max means that side is unconfigured and
 * is never enforced — matches how this batch data has always behaved
 * (an unset limit imposes no constraint), so a batch with legacy/missing
 * limits keeps its exact prior behavior.
 */
export type PurchaseAmountRangeReason = "BELOW_MIN" | "ABOVE_MAX";

export interface PurchaseAmountRangeCheck {
  valid: boolean;
  reason?: PurchaseAmountRangeReason;
  total: number;
  min: number | null;
  max: number | null;
}

export function checkPurchaseInvoiceAmountRange(
  total: number,
  min: number | null | undefined,
  max: number | null | undefined,
): PurchaseAmountRangeCheck {
  const numMin = min !== null && min !== undefined ? Number(min) : NaN;
  const numMax = max !== null && max !== undefined ? Number(max) : NaN;
  const hasMin = Number.isFinite(numMin) && numMin > 0;
  const hasMax = Number.isFinite(numMax) && numMax > 0;
  const roundedTotal = roundMoney(Number(total) || 0);

  const result: PurchaseAmountRangeCheck = {
    valid: true,
    total: roundedTotal,
    min: hasMin ? numMin : null,
    max: hasMax ? numMax : null,
  };

  if (hasMin && roundedTotal < roundMoney(numMin) - MONEY_TOLERANCE) {
    return { ...result, valid: false, reason: "BELOW_MIN" };
  }
  if (hasMax && roundedTotal > roundMoney(numMax) + MONEY_TOLERANCE) {
    return { ...result, valid: false, reason: "ABOVE_MAX" };
  }
  return result;
}

/**
 * Grandfathered comparison: an edit must never PUSH an invoice further
 * outside the configured range than it already was — the same "no
 * worse than before" pattern already used for every other invariant in
 * this validator (rate bounds, line count, category). A brand-new
 * invoice (no `originalTotal`) has no "already was", so it's held to the
 * range outright.
 */
export function isNewPurchaseAmountRangeViolation(
  newTotal: number,
  originalTotal: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
): { violates: boolean; check: PurchaseAmountRangeCheck } {
  const check = checkPurchaseInvoiceAmountRange(newTotal, min, max);
  if (check.valid) return { violates: false, check };

  if (originalTotal === null || originalTotal === undefined) {
    return { violates: true, check };
  }

  const origCheck = checkPurchaseInvoiceAmountRange(originalTotal, min, max);
  const sameGrandfatheredViolation =
    !origCheck.valid &&
    origCheck.reason === check.reason &&
    (check.reason === "BELOW_MIN"
      ? check.total >= origCheck.total - MONEY_TOLERANCE
      : check.total <= origCheck.total + MONEY_TOLERANCE);

  return { violates: !sameGrandfatheredViolation, check };
}

export type LineCandidate = {
  line: PurchaseLine;
  delta: number;
  cost: number;
};

export type GeneratedLineCandidate = {
  line: PurchaseLine;
  delta: number;
  quantity: number;
  rate: number;
  amount: number;
};

export type GeneratedInvoiceLineCandidates = {
  productId: string;
  originalLine: PurchaseLine;
  candidates: GeneratedLineCandidate[];
};

export type InvoiceCandidate = {
  invoiceId: string;
  products: PurchaseLine[];
  totalAmount: number;
  delta: number;
  cost: number;
};

export type BalancePlan = {
  editedInvoice: PurchaseInvoice;
  balancingInvoices: PurchaseInvoice[];
};

export type SolverOutcome =
  | "solution_found"
  | "no_valid_solution"
  | "search_capacity_exceeded";

export type SolverPlan = {
  editedInvoice: PurchaseInvoice;
  balancingInvoices: PurchaseInvoice[];
  totalCost: number;
  batchDelta: number;
};

export type SolverResult =
  | {
      outcome: "solution_found";
      plan: SolverPlan;
      statesExplored: number;
      executionTimeMs: number;
    }
  | {
      outcome: "no_valid_solution";
      reason: string;
      statesExplored: number;
      executionTimeMs: number;
    }
  | {
      outcome: "search_capacity_exceeded";
      reason: string;
      statesExplored: number;
      executionTimeMs: number;
    };

export type FinalValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

export function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export function normaliseCategory(value?: string | null) {
  return String(value || "Meat")
    .toUpperCase()
    .includes("FRUIT")
    ? "FRUITS"
    : "MEAT";
}
