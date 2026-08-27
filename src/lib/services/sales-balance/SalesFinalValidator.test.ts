import { describe, expect, it } from "vitest";
import { SalesFinalValidator } from "./SalesFinalValidator";
import type {
  SalesBalanceContext,
  SalesInvoice,
  SalesProductConstraint,
  SalesSolverPlan,
} from "./types";

const PRODUCT_A = "product-a";

// Every line in these tests uses quantity = 1, so `rate` and `amount` are
// numerically identical to the total being tested. This sidesteps two
// unrelated Sales invariants that are orthogonal to the MIN check under
// test here: Rule 4 (rate must be a whole integer) and Rule 1 (weight
// quantities must land on a 0.25kg step) — with quantity fixed at 1, any
// whole-rupee amount (which is all Sales line amounts ever are, since
// computeLineAmount always rounds to the nearest rupee) is trivially a
// valid rate. It also means each product's total quantity across the
// batch never changes, which keeps Rule 7 (exact quantity conservation)
// satisfied for free in every scenario below.
function makeLine(amount: number, productId = PRODUCT_A) {
  return {
    product_id: productId,
    product_name: productId,
    hsn_code: "1234",
    unit_of_measure: "kg",
    category: "Meat",
    quantity: 1,
    rate: amount,
    amount,
  };
}

function makeInvoice(id: string, amount: number): SalesInvoice {
  return {
    id,
    invoice_batch_id: "batch-1",
    invoice_number: `SB-${id}`,
    invoice_date: "2026-09-01",
    products: [makeLine(amount)],
    total_amount: amount,
  };
}

function makeConstraints(): Map<string, SalesProductConstraint> {
  return new Map([
    [
      PRODUCT_A,
      {
        productId: PRODUCT_A,
        category: "Meat",
        unitOfMeasure: "kg",
        quantityMin: 0,
        quantityMax: 100000,
        rateMin: 1,
        rateMax: 1000000,
      },
    ],
  ]);
}

/**
 * Builds a context with exactly two original invoices (both product A, qty
 * 1 each) — `edited` and `balancing` — and a plan that edits both totals.
 * Because quantity never changes, the only way to keep Rule 11 (exact
 * batch total conservation) and Rule 7 (exact quantity conservation)
 * satisfied is for balNew = balOrig + (editedOrig - editedNew), which each
 * test computes explicitly so that ONLY the MIN/MAX range check is what
 * can fail.
 */
function makeScenario(
  editedOrig: number,
  balOrig: number,
  editedNew: number,
  balNew: number,
  thresholdMin: number | undefined,
  thresholdMax: number | undefined,
): { context: SalesBalanceContext; plan: SalesSolverPlan } {
  const originalEdited = makeInvoice("inv-edited", editedOrig);
  const originalBalancing = makeInvoice("inv-balancing", balOrig);

  const context: SalesBalanceContext = {
    batchId: "batch-1",
    batchTotal: editedOrig + balOrig,
    thresholdMin,
    thresholdMax,
    stockSourceBatchId: null,
    originalProductTotals: new Map([[PRODUCT_A, 2]]),
    availableStockMap: new Map(),
    totalPurchasedByProduct: new Map(),
    invoices: [originalEdited, originalBalancing],
    constraints: makeConstraints(),
    majorCustomerIds: new Set(),
  };

  const plan: SalesSolverPlan = {
    editedInvoice: makeInvoice("inv-edited", editedNew),
    balancingInvoices: [makeInvoice("inv-balancing", balNew)],
    totalCost: 0,
    batchDelta: 0,
    productDeltas: new Map(),
  };

  return { context, plan };
}

describe("SalesFinalValidator.validateRebalancedBatch — Minimum Invoice Amount (Sprint 1.5B)", () => {
  const MIN = 10000;
  const MAX = 20000;

  it("TEST 1: newly-created violation — edited from 15000 to 9900 (below MIN) FAILS", () => {
    const { context, plan } = makeScenario(15000, 8000, 9900, 13100, MIN, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Minimum Invoice Amount")),
    ).toBe(true);
  });

  it("TEST 2: exactly at minimum (10000) — PASS", () => {
    const { context, plan } = makeScenario(15000, 8000, 10000, 13000, MIN, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(true);
  });

  it("TEST 3: comfortably inside range (14000) — PASS", () => {
    const { context, plan } = makeScenario(15000, 8000, 14000, 9000, MIN, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(true);
  });

  it("TEST 4: existing Sales MAX behavior is unchanged — exactly at maximum (20000) PASSES, just above (20100) FAILS", () => {
    // balOrig is 18000 here (rather than the 8000 used elsewhere) purely so
    // the balancing invoice's own compensating total stays comfortably
    // within [MIN, MAX] and doesn't trip the very check this test isn't
    // about — MAX behavior is what's under test here, not MIN.
    const atMax = makeScenario(15000, 18000, 20000, 13000, MIN, MAX);
    expect(
      SalesFinalValidator.validateRebalancedBatch(atMax.context, atMax.plan)
        .valid,
    ).toBe(true);

    const aboveMax = makeScenario(15000, 18000, 20100, 12900, MIN, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(
      aboveMax.context,
      aboveMax.plan,
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Maximum Invoice Amount")),
    ).toBe(true);
  });

  it("TEST 5: an invoice valid at 15000 edited down to 9000 — FAILS", () => {
    const { context, plan } = makeScenario(15000, 8000, 9000, 14000, MIN, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Minimum Invoice Amount")),
    ).toBe(true);
  });

  it("TEST 6a (grandfathering): an already-below-MIN invoice edited CLOSER to valid — PASS (not made worse)", () => {
    // Original was already 8000 (below MIN=10000) from before this check
    // existed. Editing it up to 8500 moves it closer to valid, not worse —
    // mirrors the grandfathering policy already used by the Sales MAX
    // check (and by Sprint 1.5A's Purchase MIN/MAX check). balOrig is
    // 15000 (well clear of MIN) purely so the compensating balancing
    // invoice doesn't itself trip MIN — this test is about the edited
    // invoice's own grandfathering, not the balancing invoice's.
    const { context, plan } = makeScenario(8000, 15000, 8500, 14500, MIN, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(true);
  });

  it("TEST 6b (NOT grandfathered): an already-below-MIN invoice edited even lower — FAIL", () => {
    const { context, plan } = makeScenario(8000, 8000, 7000, 9000, MIN, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Minimum Invoice Amount")),
    ).toBe(true);
  });

  it("TEST 7: one invoice newly falling below MIN fails the ENTIRE batch validation, not just that invoice", () => {
    // Same construction as TEST 1 — inv-balancing (13100) is comfortably
    // valid on its own, but the single valid/invalid verdict covers the
    // whole plan, so nothing partially saves (see AutoBalanceEngine.ts,
    // which throws on any error here before persistBalancePlan runs).
    const { context, plan } = makeScenario(15000, 8000, 9900, 13100, MIN, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(false);
  });

  it("TEST 8: monetary precision at the exact boundary (whole-rupee, the only granularity Sales amounts ever have)", () => {
    // Sales line amounts are always whole rupees by construction
    // (computeLineAmount rounds every line to the nearest rupee, so a
    // total_amount can never carry sub-rupee precision in valid data) —
    // confirmed by inspecting src/lib/utils/quantity-rate-utils.ts. The
    // meaningful boundary check is therefore whole-rupee granularity: one
    // rupee under the threshold fails, exactly at the threshold passes.
    const belowByOne = makeScenario(15000, 8000, 9999, 13001, MIN, MAX);
    expect(
      SalesFinalValidator.validateRebalancedBatch(
        belowByOne.context,
        belowByOne.plan,
      ).valid,
    ).toBe(false);

    const atThreshold = makeScenario(15000, 8000, 10000, 13000, MIN, MAX);
    expect(
      SalesFinalValidator.validateRebalancedBatch(
        atThreshold.context,
        atThreshold.plan,
      ).valid,
    ).toBe(true);
  });

  it("TEST 9: no configured minimum — preserves existing behavior (never blocks on MIN)", () => {
    const { context, plan } = makeScenario(15000, 8000, 1, 22999, 0, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    // May still be invalid for an unrelated reason (e.g. MAX), but never
    // because of a Minimum Invoice Amount error.
    if (!result.valid) {
      expect(
        (result.errors || []).some((e) => e.includes("Minimum Invoice Amount")),
      ).toBe(false);
    }
  });

  it("TEST 10: balancing/reconciliation produces one newly-below-MIN invoice on the NON-edited invoice — rejected", () => {
    // The directly-edited invoice moves UP to exactly the maximum (fine on
    // its own); the balancing invoice absorbs the opposite side of that
    // change and, as a side effect, drops below MIN. This proves the
    // check runs over every invoice the balancing pass touches, not just
    // the one the user directly edited.
    const { context, plan } = makeScenario(15000, 8000, 20000, 3000, MIN, MAX);
    const result = SalesFinalValidator.validateRebalancedBatch(context, plan);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Minimum Invoice Amount")),
    ).toBe(true);
  });
});
