export const BALANCE_LIMITS = {
  maxInvoiceLines: 8,
  maxQuantityCandidates: 12,
  maxRateCandidates: 5,
  maxLineCandidates: 24,
  maxInvoiceCandidates: 16,
  maxSolverStates: 20_000,
  residualInvoiceCount: 3,
  maxResidualCombinations: 4_096,
  plannerTimeMs: 2_000,
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
};

export type PurchaseBalanceContext = {
  batchId: string;
  batchTotal: number;
  supplierCategory: string;
  invoices: PurchaseInvoice[];
  constraints: Map<string, ProductConstraint>;
};

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
