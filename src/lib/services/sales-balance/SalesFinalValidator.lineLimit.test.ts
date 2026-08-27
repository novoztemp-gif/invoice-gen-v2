import { describe, expect, it } from "vitest";
import { SalesFinalValidator } from "./SalesFinalValidator";
import { SALES_BALANCE_LIMITS } from "./types";
import type {
  SalesBalanceContext,
  SalesInvoice,
  SalesLine,
  SalesProductConstraint,
  SalesSolverPlan,
} from "./types";

/**
 * Sprint 1.7R — Gap B regression tests.
 *
 * SALES_BALANCE_LIMITS.maxInvoiceLines (8) already existed (used only to
 * bound SalesCandidateSolver's own combinatorial search) but was never
 * actually enforced as a persistence gate anywhere on the Sales side —
 * unlike Purchase, whose FinalValidator.validateSingleInvoice already
 * rejects a newly-grown >8-line invoice. This mirrors that exact
 * grandfathering rule for Sales.
 *
 * Every fixture below deliberately keeps Rule 11 (exact batch total) and
 * Rule 7 (exact per-product quantity conservation) satisfied by
 * construction — `original.total_amount` is set to match whatever the plan
 * produces, and `context.originalProductTotals` is derived directly from
 * the PLANNED (post-edit) product quantities rather than from `original`'s
 * own lines — so those two pre-existing, unrelated invariants can never
 * fire here, isolating the new line-count check under test.
 */

function makeLines(count: number, amountEach = 100): SalesLine[] {
  return Array.from({ length: count }, (_, i) => ({
    product_id: `product-${i}`,
    product_name: `product-${i}`,
    hsn_code: "1234",
    unit_of_measure: "kg",
    category: "Meat",
    quantity: 1,
    rate: amountEach,
    amount: amountEach,
  }));
}

function makeInvoice(
  id: string,
  lines: SalesLine[],
  customerId?: string,
): SalesInvoice {
  const products = customerId
    ? lines.map((l) => ({ ...l, customer_id: customerId }))
    : lines;
  return {
    id,
    invoice_batch_id: "batch-1",
    invoice_number: `SB-${id}`,
    invoice_date: "2026-09-01",
    products,
    total_amount: products.reduce((sum, l) => sum + l.amount, 0),
  };
}

function makeConstraints(): Map<string, SalesProductConstraint> {
  const map = new Map<string, SalesProductConstraint>();
  for (let i = 0; i < 20; i++) {
    map.set(`product-${i}`, {
      productId: `product-${i}`,
      category: "Meat",
      unitOfMeasure: "kg",
      quantityMin: 0,
      quantityMax: 100000,
      rateMin: 1,
      rateMax: 1000000,
    });
  }
  return map;
}

function sumQuantities(...invoiceGroups: SalesInvoice[][]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const group of invoiceGroups) {
    for (const inv of group) {
      for (const p of inv.products) {
        totals.set(p.product_id, (totals.get(p.product_id) || 0) + p.quantity);
      }
    }
  }
  return totals;
}

/**
 * Builds a context/plan pair for a single edited invoice, with
 * `original.total_amount` forced to equal the planned total (Rule 11) and
 * `originalProductTotals` derived from the planned invoices themselves
 * (Rule 7) — both invariants trivially satisfied regardless of how many
 * lines `originalLineCount` vs the plan's invoices actually carry.
 */
function makeScenario(
  originalLineCount: number,
  plannedInvoices: { editedInvoice: SalesInvoice; newInvoices?: SalesInvoice[] },
  majorCustomerIds: Set<string> = new Set(),
): { context: SalesBalanceContext; plan: SalesSolverPlan } {
  const original = makeInvoice(
    "inv-1",
    makeLines(originalLineCount),
    plannedInvoices.editedInvoice.products[0]?.customer_id,
  );
  original.total_amount = plannedInvoices.editedInvoice.total_amount;

  const originalProductTotals = sumQuantities(
    [plannedInvoices.editedInvoice],
    plannedInvoices.newInvoices || [],
  );

  const context: SalesBalanceContext = {
    batchId: "batch-1",
    batchTotal: original.total_amount,
    thresholdMin: undefined,
    thresholdMax: undefined,
    stockSourceBatchId: null,
    originalProductTotals,
    availableStockMap: new Map(),
    totalPurchasedByProduct: new Map(),
    invoices: [original],
    constraints: makeConstraints(),
    majorCustomerIds,
  };

  const plan: SalesSolverPlan = {
    editedInvoice: plannedInvoices.editedInvoice,
    balancingInvoices: [],
    totalCost: 0,
    batchDelta: 0,
    productDeltas: new Map(),
    newInvoices: plannedInvoices.newInvoices,
  };

  return { context, plan };
}

describe("SalesFinalValidator.validateRebalancedBatch — Product Line Limit (Sprint 1.7R Gap B)", () => {
  it("growing a 5-line invoice to 9 lines (over the 8-line cap) is REJECTED", () => {
    const { context, plan } = makeScenario(5, {
      editedInvoice: makeInvoice("inv-1", makeLines(9)),
    });
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Product Line Limit Exceeded")),
    ).toBe(true);
  });

  it("exactly 8 lines PASSES (at the cap, not over it)", () => {
    const { context, plan } = makeScenario(5, {
      editedInvoice: makeInvoice("inv-1", makeLines(8)),
    });
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(true);
  });

  it("grandfathering: an invoice that ALREADY had 10 lines before this edit stays editable as long as the count doesn't grow further", () => {
    const { context, plan } = makeScenario(10, {
      editedInvoice: makeInvoice("inv-1", makeLines(10, 150)),
    });
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(
      (result.errors || []).some((e) => e.includes("Product Line Limit Exceeded")),
    ).toBe(false);
  });

  it("NOT grandfathered: an already-over-limit invoice (10 lines) growing even further (12 lines) is REJECTED", () => {
    const { context, plan } = makeScenario(10, {
      editedInvoice: makeInvoice("inv-1", makeLines(12)),
    });
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Product Line Limit Exceeded")),
    ).toBe(true);
  });

  it("major-customer invoices are exempt from the cap, mirroring Purchase's identical exemption", () => {
    const { context, plan } = makeScenario(
      5,
      { editedInvoice: makeInvoice("inv-1", makeLines(12), "maj-1") },
      new Set(["maj-1"]),
    );
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(
      (result.errors || []).some((e) => e.includes("Product Line Limit Exceeded")),
    ).toBe(false);
  });

  it("a brand-new invoice (no original) is held to the cap outright — 9 lines on a new invoice is REJECTED", () => {
    const editedInvoice = makeInvoice("inv-1", makeLines(5));
    const newInvoice = makeInvoice("inv-new", makeLines(9, 50));
    const { context, plan } = makeScenario(5, {
      editedInvoice,
      newInvoices: [newInvoice],
    });
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Product Line Limit Exceeded")),
    ).toBe(true);
  });

  it("SALES_BALANCE_LIMITS.maxInvoiceLines is still exactly 8 — this test file assumes that constant, not a hardcoded literal", () => {
    expect(SALES_BALANCE_LIMITS.maxInvoiceLines).toBe(8);
  });
});
