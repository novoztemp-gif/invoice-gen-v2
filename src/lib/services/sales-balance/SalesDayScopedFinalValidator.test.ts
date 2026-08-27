import { describe, expect, it } from "vitest";
import { SalesDayScopedFinalValidator } from "./SalesDayScopedFinalValidator";
import type {
  SalesBalanceContext,
  SalesInvoice,
  SalesProductConstraint,
  SalesSolverPlan,
} from "./types";

const PRODUCT_A = "product-a";
const PRODUCT_B = "product-b";

function makeLine(
  productId: string,
  quantity: number,
  rate: number,
  overrides: Partial<any> = {},
) {
  return {
    product_id: productId,
    product_name: productId,
    hsn_code: "1234",
    unit_of_measure: "kg",
    category: "Meat",
    quantity,
    rate,
    amount: Math.round(quantity * rate),
    ...overrides,
  };
}

function makeInvoice(
  id: string,
  date: string,
  lines: ReturnType<typeof makeLine>[],
): SalesInvoice {
  return {
    id,
    invoice_batch_id: "batch-1",
    invoice_number: id,
    invoice_date: date,
    products: lines,
    total_amount: lines.reduce((s, l) => s + l.amount, 0),
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
    [
      PRODUCT_B,
      {
        productId: PRODUCT_B,
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

function baseContext(
  invoices: SalesInvoice[],
  overrides: Partial<SalesBalanceContext> = {},
): SalesBalanceContext {
  return {
    batchId: "batch-1",
    batchTotal: invoices.reduce((s, i) => s + i.total_amount, 0),
    stockSourceBatchId: null,
    originalProductTotals: new Map(),
    availableStockMap: new Map(),
    totalPurchasedByProduct: new Map(),
    invoices,
    constraints: makeConstraints(),
    majorCustomerIds: new Set(),
    ...overrides,
  };
}

describe("SalesDayScopedFinalValidator.validate", () => {
  it("passes a same-day reuse edit: edited invoice decreases, absorbing invoice increases by the exact same amount, at its own existing rate", () => {
    const origEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 10, 100),
    ]);
    const origAbsorb = makeInvoice("absorb", "2026-08-05", [
      makeLine(PRODUCT_A, 5, 80),
    ]);
    const context = baseContext([origEdited, origAbsorb]);

    // edited: 1000 -> 500 (-500). absorb: 400 -> 900 (+500). Net 0 — the
    // freed 5kg from the edited invoice moves entirely onto the absorbing
    // invoice's existing line, at the absorbing invoice's OWN rate (80),
    // never the edited invoice's rate.
    const newEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 5, 100),
    ]);
    const newAbsorb = makeInvoice("absorb", "2026-08-05", [
      makeLine(PRODUCT_A, 11.25, 80),
    ]);
    const plan: SalesSolverPlan = {
      editedInvoice: newEdited,
      balancingInvoices: [newAbsorb],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    const result = SalesDayScopedFinalValidator.validate(
      context,
      plan,
      new Set([PRODUCT_A]),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects when the touched subset's grand total drifts (batch total not conserved)", () => {
    const origEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 10, 100),
    ]);
    const context = baseContext([origEdited]);
    const newEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 12, 100),
    ]);
    const plan: SalesSolverPlan = {
      editedInvoice: newEdited,
      balancingInvoices: [],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    const result = SalesDayScopedFinalValidator.validate(
      context,
      plan,
      new Set([PRODUCT_A]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Batch Total Mismatch")),
    ).toBe(true);
  });

  it("allows the edited product's own batch-wide quantity to change (the core difference from SalesFinalValidator)", () => {
    const origEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 10, 100),
    ]);
    const origAbsorb = makeInvoice("absorb", "2026-08-05", [
      makeLine(PRODUCT_A, 5, 100),
    ]);
    const context = baseContext([origEdited, origAbsorb], {
      originalProductTotals: new Map([[PRODUCT_A, 15]]),
      totalPurchasedByProduct: new Map([[PRODUCT_A, 1000]]),
    });
    // Edited invoice quantity increases from 10 to 12 (genuine net +2kg,
    // absorbed via a rate-nudge on the OTHER invoice rather than quantity
    // movement) — product A's batch-wide quantity total is now 17, not 15.
    const newEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 12, 100),
    ]);
    const newAbsorb = makeInvoice("absorb", "2026-08-05", [
      makeLine(PRODUCT_A, 5, 60),
    ]);
    // edited: 1000 -> 1200 (+200). absorb: 500 -> 300 (-200). Net 0.
    const plan: SalesSolverPlan = {
      editedInvoice: newEdited,
      balancingInvoices: [newAbsorb],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    const result = SalesDayScopedFinalValidator.validate(
      context,
      plan,
      new Set([PRODUCT_A]),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects when a NON-edited product's quantity moves (rate-nudge must never change quantity of an untouched product)", () => {
    const origEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 10, 100),
    ]);
    const origAbsorb = makeInvoice("absorb", "2026-08-05", [
      makeLine(PRODUCT_B, 5, 100),
    ]);
    const context = baseContext([origEdited, origAbsorb]);
    const newEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 10, 100),
    ]);
    // Product B's quantity changed even though it's not in editedProductIds.
    const newAbsorb = makeInvoice("absorb", "2026-08-05", [
      makeLine(PRODUCT_B, 6, 100),
    ]);
    const plan: SalesSolverPlan = {
      editedInvoice: newEdited,
      balancingInvoices: [newAbsorb],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    const result = SalesDayScopedFinalValidator.validate(
      context,
      plan,
      new Set([PRODUCT_A]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Product quantity total mismatch")),
    ).toBe(true);
  });

  it("grandfathers an invoice already below thresholdMin when it moves closer to valid, but rejects pushing it further below", () => {
    const MIN = 1000;
    const origEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 8, 90), // 720, already below MIN
    ]);
    // A same-day compensating invoice, large enough that a +/-90 nudge
    // never brings IT anywhere near thresholdMin — isolates this test to
    // the edited invoice's own grandfather behavior only.
    const origAbsorb = makeInvoice("absorb", "2026-08-05", [
      makeLine(PRODUCT_A, 90, 100), // 9000
    ]);
    const context = baseContext([origEdited, origAbsorb], {
      thresholdMin: MIN,
    });

    // edited: 720 -> 810 (+90). absorb: 9000 -> 8910 (-90). Net 0.
    const closerToValid = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 9, 90), // 810, still below MIN but closer
    ]);
    const absorbForCloser = makeInvoice("absorb", "2026-08-05", [
      makeLine(PRODUCT_A, 90, 99), // 8910 — same quantity, rate nudged down
    ]);
    const planCloser: SalesSolverPlan = {
      editedInvoice: closerToValid,
      balancingInvoices: [absorbForCloser],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    expect(
      SalesDayScopedFinalValidator.validate(
        context,
        planCloser,
        new Set([PRODUCT_A]),
      ).valid,
    ).toBe(true);

    // edited: 720 -> 630 (-90). absorb: 9000 -> 9090 (+90). Net 0.
    const worse = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 7, 90), // 630, worse than 720
    ]);
    const absorbForWorse = makeInvoice("absorb", "2026-08-05", [
      makeLine(PRODUCT_A, 90, 101), // 9090 — same quantity, rate nudged up
    ]);
    const planWorse: SalesSolverPlan = {
      editedInvoice: worse,
      balancingInvoices: [absorbForWorse],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    const result = SalesDayScopedFinalValidator.validate(
      context,
      planWorse,
      new Set([PRODUCT_A]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Minimum Invoice Amount")),
    ).toBe(true);
  });

  it("rejects an edited product's new batch-wide total exceeding the physical purchased ceiling", () => {
    const origEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 10, 100),
    ]);
    const context = baseContext([origEdited], {
      originalProductTotals: new Map([[PRODUCT_A, 10]]),
      totalPurchasedByProduct: new Map([[PRODUCT_A, 12]]),
    });
    const newEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 15, 100),
    ]);
    const plan: SalesSolverPlan = {
      editedInvoice: newEdited,
      balancingInvoices: [],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    const result = SalesDayScopedFinalValidator.validate(
      context,
      plan,
      new Set([PRODUCT_A]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Overstock Error")),
    ).toBe(true);
  });

  it("REGRESSION — an increase that pulls quantity from a same-day peer (net batch quantity unchanged) must NOT trigger a phantom overstock error", () => {
    // The new pull-from-peer behavior: edited invoice grows 10 -> 15kg,
    // fully offset by a peer invoice shrinking 8 -> 3kg (same product, same
    // day). The batch-wide total for this product is exactly unchanged
    // (18kg before, 18kg after) — using only the EDITED invoice's own
    // delta (the old, buggy formula) would have computed a phantom +5kg
    // increase (23kg) and wrongly rejected this against a ceiling sitting
    // exactly at 18.
    const origEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 10, 100),
    ]);
    const origPeer = makeInvoice("peer", "2026-08-05", [
      makeLine(PRODUCT_A, 8, 100),
    ]);
    const context = baseContext([origEdited, origPeer], {
      originalProductTotals: new Map([[PRODUCT_A, 18]]),
      totalPurchasedByProduct: new Map([[PRODUCT_A, 18]]), // tightest possible ceiling
    });
    const newEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 15, 100),
    ]);
    const newPeer = makeInvoice("peer", "2026-08-05", [
      makeLine(PRODUCT_A, 3, 100),
    ]);
    const plan: SalesSolverPlan = {
      editedInvoice: newEdited,
      balancingInvoices: [newPeer],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    const result = SalesDayScopedFinalValidator.validate(
      context,
      plan,
      new Set([PRODUCT_A]),
    );
    expect(result.valid).toBe(true);
  });

  it("REGRESSION — grandfathers a product whose batch-wide total was ALREADY over its purchased ceiling before this edit, as long as this edit doesn't make it any worse", () => {
    // Real reported false rejection: priorQty (900.5) already exceeds the
    // ceiling (891.5) from historical/pre-existing data — nothing to do
    // with this edit. A fully net-zero same-day swap (edited invoice
    // +10kg, peer -10kg) leaves the batch-wide total EXACTLY where it
    // already was; must not be blamed on the edit.
    const origEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 20, 100),
    ]);
    const origPeer = makeInvoice("peer", "2026-08-05", [
      makeLine(PRODUCT_A, 880.5, 100),
    ]);
    const context = baseContext([origEdited, origPeer], {
      originalProductTotals: new Map([[PRODUCT_A, 900.5]]),
      totalPurchasedByProduct: new Map([[PRODUCT_A, 891.5]]),
    });
    const newEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 30, 100),
    ]);
    const newPeer = makeInvoice("peer", "2026-08-05", [
      makeLine(PRODUCT_A, 870.5, 100),
    ]);
    const plan: SalesSolverPlan = {
      editedInvoice: newEdited,
      balancingInvoices: [newPeer],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    const result = SalesDayScopedFinalValidator.validate(
      context,
      plan,
      new Set([PRODUCT_A]),
    );
    expect(result.valid).toBe(true);
  });

  it("still rejects a GENUINE increase past the already-over-ceiling total (grandfathering never lets it get worse)", () => {
    const origEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 20, 100),
    ]);
    const origPeer = makeInvoice("peer", "2026-08-05", [
      makeLine(PRODUCT_A, 880.5, 100),
    ]);
    const context = baseContext([origEdited, origPeer], {
      originalProductTotals: new Map([[PRODUCT_A, 900.5]]),
      totalPurchasedByProduct: new Map([[PRODUCT_A, 891.5]]),
    });
    // Edited invoice grows +10 (20 -> 30) but the peer only gives up 5
    // (880.5 -> 875.5) — a genuine +5 net increase past the already-over
    // total of 900.5, up to 905.5.
    const newEdited = makeInvoice("edited", "2026-08-05", [
      makeLine(PRODUCT_A, 30, 100),
    ]);
    const newPeer = makeInvoice("peer", "2026-08-05", [
      makeLine(PRODUCT_A, 875.5, 100),
    ]);
    const plan: SalesSolverPlan = {
      editedInvoice: newEdited,
      balancingInvoices: [newPeer],
      totalCost: 0,
      batchDelta: 0,
      productDeltas: new Map(),
    };
    const result = SalesDayScopedFinalValidator.validate(
      context,
      plan,
      new Set([PRODUCT_A]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(
      (result.errors || []).some((e) => e.includes("Overstock Error")),
    ).toBe(true);
  });
});
