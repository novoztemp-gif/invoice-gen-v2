export const SALES_BALANCE_LIMITS = {
  maxInvoiceLines: 8,
  maxQuantityCandidates: 40,
  maxRateCandidates: 5,
  maxLineCandidates: 32,
  maxInvoiceCandidates: 128,
  maxSearchStates: 20000,
  searchTimeoutMs: 5000,
  residualInvoiceCount: 3,
  maxResidualCombinations: 1000,
};

export const SALES_BALANCE_COST = {
  quantityStep: 10,
  rateStep: 50,
  rateRupee: 50,
  changedLine: 20,
  changedInvoice: 100,
  quantityBoundary: 500,
  rateBoundary: 500,
};

export function roundMoney(amount: number): number {
  if (isNaN(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

export interface SalesProductConstraint {
  productId: string;
  category: string;
  unitOfMeasure: string;
  quantityMin: number;
  quantityMax: number;
  rateMin: number;
  rateMax: number;
}

export interface SalesLine {
  product_id: string;
  product_name?: string;
  hsn_code?: string;
  unit_of_measure?: string;
  category?: string;
  quantity: number;
  rate: number;
  amount: number;
  customer_id?: string;
}

export interface SalesInvoice {
  id: string;
  invoice_batch_id: string;
  invoice_number: string;
  invoice_date: string;
  products: SalesLine[];
  total_amount: number;
  transport_mode?: string | null;
  vehicle_number?: string | null;
  date_of_supply?: string | null;
}

export interface SalesInvoiceUpdate {
  products?: SalesLine[];
  total_amount?: number;
  transport_mode?: string | null;
  vehicle_number?: string | null;
  date_of_supply?: string | null;
}

export interface SalesBalanceContext {
  batchId: string;
  batchTotal: number;
  stockSourceBatchId: string | null;
  originalProductTotals: Map<string, number>;
  availableStockMap: Map<string, number>;
  invoices: SalesInvoice[];
  constraints: Map<string, SalesProductConstraint>;
}

export interface SalesGeneratedLineCandidate {
  line: SalesLine;
  delta: number;
  quantity: number;
  rate: number;
  amount: number;
}

export interface SalesGeneratedInvoiceLineCandidates {
  productId: string;
  originalLine: SalesLine;
  candidates: SalesGeneratedLineCandidate[];
}

export interface SalesLineCandidate {
  productId: string;
  quantity: number;
  rate: number;
  amount: number;
  cost: number;
}

export interface SalesInvoiceCandidate {
  invoiceId: string;
  products: SalesLine[];
  totalAmount: number;
  cost: number;
}

export interface SalesSolverPlan {
  editedInvoice: SalesInvoice;
  balancingInvoices: SalesInvoice[];
  totalCost: number;
  batchDelta: number;
  productDeltas: Map<string, number>;
}

export interface SalesSolverResult {
  outcome: "solution_found" | "limits_exceeded" | "no_solution";
  plan?: SalesSolverPlan;
  message?: string;
}

export interface SalesFinalValidationResult {
  valid: boolean;
  errors?: string[];
}
